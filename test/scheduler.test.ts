// scheduler tests — DAG execution, revise loop, timeout, merge order.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Dispatcher, waitForTerminal } from '../src/dispatcher.js';
import { Scheduler } from '../src/scheduler.js';
import { Verifier } from '../src/verifier.js';
import { codebuddyAdapter } from '../src/adapters/codebuddy.js';
import { qoderAdapter } from '../src/adapters/qoder.js';
import { createMission, submitPlan } from '../src/planner.js';
import { makeTempGitRepo, tempDbPath, git } from './helpers.js';

const fakeBin = join(process.cwd(), 'scripts', 'fake-executor.mjs');

function setup(opts: { timeoutMs?: number } = {}): {
  store: Store;
  scheduler: Scheduler;
  dispatcher: Dispatcher;
  dataDir: string;
} {
  chmodSync(fakeBin, 0o755);
  process.env.ORCHESTRATOR_CODEBUDDY_BIN = fakeBin;
  process.env.ORCHESTRATOR_QODER_BIN = fakeBin;
  const dataDir = mkdtempSync(join(tmpdir(), 'orch-sched-'));
  const store = new Store(tempDbPath());
  const adapters = new Map([
    ['codebuddy', codebuddyAdapter],
    ['qoder', qoderAdapter],
  ]);
  const dispatcher = new Dispatcher(store, adapters, dataDir, { finalizeTasks: false });
  const verifier = new Verifier(store, adapters, 30_000);
  const scheduler = new Scheduler(store, dispatcher, verifier, {
    concurrencyPerMission: 2,
    attemptTimeoutMs: opts.timeoutMs ?? 30 * 60 * 1000,
  });
  return { store, scheduler, dispatcher, dataDir };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function tickUntil(
  scheduler: Scheduler,
  store: Store,
  missionId: string,
  done: (status: string | undefined) => boolean,
  maxTicks = 60,
): Promise<string | undefined> {
  for (let i = 0; i < maxTicks; i++) {
    await scheduler.tick();
    const status = store.getMission(missionId)?.status;
    if (done(status)) return status;
    await sleep(400);
  }
  return store.getMission(missionId)?.status;
}

const planAB = [
  {
    key: 'a',
    title: 'Task A',
    prompt: 'create hello.ts',
    contract: 'hello.ts exists',
    acceptance: 'hello.ts exports hello',
  },
  {
    key: 'b',
    title: 'Task B',
    prompt: 'extend hello.ts',
    contract: 'hello.ts still exists',
    acceptance: 'hello.ts exports hello',
    depends_on: ['a'],
  },
];

describe('scheduler', () => {
  it('runs a 2-task DAG in order and merges both to integration', async () => {
    process.env.FAKE_MODE = 'success';
    const { store, scheduler } = setup();
    const repo = await makeTempGitRepo();
    try {
      const mission = createMission(store, { goal: 'two tasks', repo });
      submitPlan(store, { mission_id: mission.id, tasks: planAB });
      const status = await tickUntil(scheduler, store, mission.id, (s) => s === 'done');
      assert.equal(status, 'done');
      // B only ran after A was done (its attempt started after A's merge).
      const tasks = store.listTasksByMission(mission.id);
      const aAttempts = store.listAttemptsByTask(tasks.find((t) => t.key === 'a')!.id);
      const bAttempts = store.listAttemptsByTask(tasks.find((t) => t.key === 'b')!.id);
      assert.equal(aAttempts.length, 1);
      assert.equal(bAttempts.length, 1);
      assert.ok(Date.parse(bAttempts[0].createdAt) >= Date.parse(aAttempts[0].createdAt));
      // Both merged to the integration branch, B's merge after A's.
      const log = await git(repo, ['log', '--oneline', 'orchestrator/integration']);
      assert.match(log, /Task A/);
      assert.match(log, /Task B/);
      assert.ok(log.indexOf('Task B') < log.indexOf('Task A')); // newest first
      // DAG invariant: B's worktree was based on A's merge commit (the
      // integration head), not on main — B builds on A's merged result.
      const aWt = store.getWorktreeByAttempt(aAttempts[0].id);
      const bWt = store.getWorktreeByAttempt(bAttempts[0].id);
      assert.ok(aWt && bWt);
      const integrationHead = await git(repo, ['rev-parse', 'orchestrator/integration']);
      const aMergeCommit = await git(repo, [
        'log',
        '--format=%H',
        '--grep=Task A',
        'orchestrator/integration',
      ]);
      assert.equal(bWt.baseCommit, aMergeCommit.trim().split('\n')[0]);
      assert.notEqual(bWt.baseCommit, aWt.baseCommit);
      assert.ok(integrationHead.length > 0);
      // Main untouched.
      await assert.rejects(git(repo, ['show', 'main:hello.ts']));
    } finally {
      store.close();
    }
  });

  it('revise loop: failed attempt is revised once, then passes', async () => {
    process.env.FAKE_MODE = 'fail-once';
    process.env.FAKE_ONCE_KEY = `revise-${Date.now()}`;
    const { store, scheduler } = setup();
    const repo = await makeTempGitRepo();
    try {
      const mission = createMission(store, { goal: 'revise me', repo });
      submitPlan(store, {
        mission_id: mission.id,
        tasks: [planAB[0]],
      });
      const status = await tickUntil(scheduler, store, mission.id, (s) => s === 'done');
      assert.equal(status, 'done');
      const task = store.listTasksByMission(mission.id)[0];
      assert.equal(task.revisionsUsed, 1);
      assert.equal(store.listAttemptsByTask(task.id).length, 2);
    } finally {
      store.close();
    }
  });

  it('full failure chain: revise x2 -> reroute -> replan proposal', async () => {
    process.env.FAKE_MODE = 'fail';
    const { store, scheduler } = setup();
    const repo = await makeTempGitRepo();
    try {
      const mission = createMission(store, { goal: 'always fails', repo });
      submitPlan(store, { mission_id: mission.id, tasks: [planAB[0]] });
      const status = await tickUntil(scheduler, store, mission.id, (s) => s === 'failed');
      assert.equal(status, 'failed');
      const task = store.listTasksByMission(mission.id)[0];
      assert.equal(task.status, 'failed');
      assert.equal(task.revisionsUsed, 2);
      assert.equal(task.rerouted, true);
      // 1 original + 2 revises + 1 reroute = 4 attempts, across both agents.
      const attempts = store.listAttemptsByTask(task.id);
      assert.equal(attempts.length, 4);
      assert.deepEqual(
        attempts.map((a) => a.agent),
        ['codebuddy', 'codebuddy', 'codebuddy', 'qoder'],
      );
      const proposals = store.listReplanProposals(mission.id);
      assert.equal(proposals.length, 1);
      assert.match(proposals[0].reason, /revise x2 and reroute both failed/);
    } finally {
      store.close();
    }
  });

  it('timeout aborts a slow attempt', async () => {
    process.env.FAKE_MODE = 'slow';
    const { store, scheduler } = setup({ timeoutMs: 500 });
    const repo = await makeTempGitRepo();
    try {
      const mission = createMission(store, { goal: 'slow one', repo });
      submitPlan(store, { mission_id: mission.id, tasks: [planAB[0]] });
      await scheduler.tick(); // dispatch
      await sleep(800);
      await scheduler.tick(); // timeout -> abort
      const task = store.listTasksByMission(mission.id)[0];
      const attempt = store.listAttemptsByTask(task.id)[0];
      const terminal = await waitForTerminal(store, attempt.id, 10_000);
      assert.equal(terminal.status, 'failed');
      assert.equal(terminal.exitCode, null); // killed, not exited
    } finally {
      store.close();
    }
  });
});
