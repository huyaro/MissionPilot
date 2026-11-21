// dispatcher tests — dispatch loop, isolation, failure, recovery.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Dispatcher, waitForTerminal, recoverInterruptedAttempts } from '../src/dispatcher.js';
import { codebuddyAdapter } from '../src/adapters/codebuddy.js';
import { qoderAdapter } from '../src/adapters/qoder.js';
import { makeTempGitRepo, tempDbPath, git } from './helpers.js';

const fakeBin = join(process.cwd(), 'scripts', 'fake-executor.mjs');

function setup(mode: string): { store: Store; dispatcher: Dispatcher; dataDir: string } {
  chmodSync(fakeBin, 0o755);
  process.env.ORCHESTRATOR_CODEBUDDY_BIN = fakeBin;
  process.env.FAKE_MODE = mode;
  const dataDir = mkdtempSync(join(tmpdir(), 'orch-dispatch-'));
  const store = new Store(tempDbPath());
  // Dispatch is fail-closed: the agent needs at least one configured model.
  store.upsertExecutorConfig('codebuddy', {
    models: [{ id: 'hy3', reasoning: 'high', context: '128K' }],
    defaultModel: 'hy3',
  });
  const dispatcher = new Dispatcher(store, new Map([['codebuddy', codebuddyAdapter]]), dataDir);
  return { store, dispatcher, dataDir };
}

describe('dispatcher', () => {
  it('dispatches to a worktree; main repo stays clean; attempt done with diff', async () => {
    const { store, dispatcher } = setup('success');
    const repo = await makeTempGitRepo();
    try {
      const r = await dispatcher.dispatch({
        agent: 'codebuddy',
        task: { title: 'Create hello', prompt: 'create hello.ts exporting hello()' },
        contract: 'hello.ts exists and exports hello',
        workdir: repo,
      });
      const attempt = await waitForTerminal(store, r.attemptId);
      assert.equal(attempt.status, 'done');
      assert.equal(attempt.exitCode, 0);
      const diff = JSON.parse(attempt.diffSummary ?? '{}') as { files: string[] };
      assert.ok(diff.files.includes('hello.ts'));
      assert.equal(store.listEvents(r.attemptId).length > 0, true);
      // INV-2: main repo untouched.
      assert.equal(await git(repo, ['status', '--porcelain']), '');
    } finally {
      store.close();
    }
  });

  it('dispatch returns immediately while the run continues (INV-5)', async () => {
    const { store, dispatcher } = setup('slow');
    const repo = await makeTempGitRepo();
    try {
      const r = await dispatcher.dispatch({
        agent: 'codebuddy',
        task: { title: 'Slow one', prompt: 'take your time' },
        contract: 'done eventually',
        workdir: repo,
      });
      // Immediately after dispatch returns, the attempt is still running.
      const immediate = store.getAttempt(r.attemptId);
      assert.equal(immediate?.status, 'running');
      const attempt = await waitForTerminal(store, r.attemptId);
      assert.equal(attempt.status, 'done');
    } finally {
      store.close();
    }
  });

  it('failed run: attempt failed + stderr recorded (INV-3)', async () => {
    const { store, dispatcher } = setup('fail');
    const repo = await makeTempGitRepo();
    try {
      const r = await dispatcher.dispatch({
        agent: 'codebuddy',
        task: { title: 'Will fail', prompt: 'fail please' },
        contract: 'n/a',
        workdir: repo,
      });
      const attempt = await waitForTerminal(store, r.attemptId);
      assert.equal(attempt.status, 'failed');
      assert.equal(attempt.exitCode, 1);
      assert.match(attempt.stderr ?? '', /simulated failure/);
      assert.equal(store.getTask(attempt.taskId)?.status, 'failed');
    } finally {
      store.close();
    }
  });

  it('rejects unknown agent and non-git workdir before creating records', async () => {
    const { store, dispatcher } = setup('success');
    const repo = await makeTempGitRepo();
    try {
      await assert.rejects(
        () =>
          dispatcher.dispatch({
            agent: 'nope',
            task: { title: 't', prompt: 'p' },
            contract: 'c',
            workdir: repo,
          }),
        /unknown agent/,
      );
      await assert.rejects(
        () =>
          dispatcher.dispatch({
            agent: 'codebuddy',
            task: { title: 't', prompt: 'p' },
            contract: 'c',
            workdir: '/tmp',
          }),
        /not a git repository|fatal/,
      );
    } finally {
      store.close();
    }
  });

  it('abortAttempt: scheduler timeout kills the run and the attempt fails', async () => {
    const { store, dispatcher } = setup('slow');
    const repo = await makeTempGitRepo();
    try {
      const r = await dispatcher.dispatch({
        agent: 'codebuddy',
        task: { title: 'Slow one', prompt: 'take your time' },
        contract: 'done eventually',
        workdir: repo,
      });
      assert.equal(dispatcher.abortAttempt(r.attemptId), true);
      const attempt = await waitForTerminal(store, r.attemptId);
      assert.equal(attempt.status, 'failed');
      assert.equal(attempt.exitCode, null);
      assert.equal(dispatcher.abortAttempt(r.attemptId), false); // no longer running
    } finally {
      store.close();
    }
  });

  it('recovery marks interrupted attempts failed with a note', () => {
    const store = new Store(tempDbPath());
    try {
      const m = store.createMission({ goal: 'g', repo: '/tmp/r', source: 'codex' });
      const t = store.createTask({ missionId: m.id, key: 'k', title: 't', contract: 'c' });
      const a = store.createAttempt({ taskId: t.id, agent: 'codebuddy' });
      store.updateAttempt(a.id, { status: 'running', worktreePath: '/tmp/wt' });
      assert.equal(recoverInterruptedAttempts(store), 1);
      const recovered = store.getAttempt(a.id);
      assert.equal(recovered?.status, 'failed');
      assert.match(recovered?.stderr ?? '', /restarted while this attempt was running/);
      assert.equal(recoverInterruptedAttempts(store), 0);
    } finally {
      store.close();
    }
  });

  it('refuses to dispatch when the agent has no configured models', async () => {
    chmodSync(fakeBin, 0o755);
    process.env.ORCHESTRATOR_CODEBUDDY_BIN = fakeBin;
    process.env.FAKE_MODE = 'success';
    const dataDir = mkdtempSync(join(tmpdir(), 'orch-dispatch-'));
    const store = new Store(tempDbPath());
    const dispatcher = new Dispatcher(store, new Map([['codebuddy', codebuddyAdapter]]), dataDir);
    const repo = await makeTempGitRepo();
    try {
      await assert.rejects(
        () =>
          dispatcher.dispatch({
            agent: 'codebuddy',
            task: { title: 't', prompt: 'p' },
            contract: 'c',
            workdir: repo,
          }),
        /has no configured models/,
      );
      // Fail-closed before any record is made.
      assert.equal(store.listAllMissions().length, 0);
    } finally {
      store.close();
    }
  });

  it('passes --model to the codebuddy CLI (and only --model)', async () => {
    const { store, dispatcher } = setup('success');
    const repo = await makeTempGitRepo();
    const recordPath = join(mkdtempSync(join(tmpdir(), 'orch-record-')), 'argv.log');
    const prevRecord = process.env.FAKE_RECORD_PATH;
    process.env.FAKE_RECORD_PATH = recordPath;
    try {
      const r = await dispatcher.dispatch({
        agent: 'codebuddy',
        task: { title: 'Create hello', prompt: 'create hello.ts' },
        contract: 'hello.ts exists',
        workdir: repo,
      });
      await waitForTerminal(store, r.attemptId);
      const lines = readFileSync(recordPath, 'utf8').trim().split('\n');
      assert.equal(lines.length, 1);
      const argv = JSON.parse(lines[0] as string) as string[];
      const modelIdx = argv.indexOf('--model');
      assert.notEqual(modelIdx, -1);
      assert.equal(argv[modelIdx + 1], 'hy3');
      // CodeBuddy has no verified reasoning/context flags — none are passed.
      assert.equal(argv.includes('--reasoning-effort'), false);
      assert.equal(argv.includes('--context-window'), false);
    } finally {
      if (prevRecord === undefined) delete process.env.FAKE_RECORD_PATH;
      else process.env.FAKE_RECORD_PATH = prevRecord;
      store.close();
    }
  });

  it('passes --model/--reasoning-effort/--context-window to the qoder CLI', async () => {
    chmodSync(fakeBin, 0o755);
    process.env.ORCHESTRATOR_QODER_BIN = fakeBin;
    process.env.FAKE_MODE = 'success';
    const dataDir = mkdtempSync(join(tmpdir(), 'orch-dispatch-'));
    const store = new Store(tempDbPath());
    store.upsertExecutorConfig('qoder', {
      models: [{ id: 'Qwen3.8-Max', reasoning: 'medium', context: '200K' }],
      defaultModel: 'Qwen3.8-Max',
    });
    const dispatcher = new Dispatcher(store, new Map([['qoder', qoderAdapter]]), dataDir);
    const repo = await makeTempGitRepo();
    const recordPath = join(mkdtempSync(join(tmpdir(), 'orch-record-')), 'argv.log');
    const prevRecord = process.env.FAKE_RECORD_PATH;
    process.env.FAKE_RECORD_PATH = recordPath;
    try {
      const r = await dispatcher.dispatch({
        agent: 'qoder',
        task: { title: 'Create hello', prompt: 'create hello.ts' },
        contract: 'hello.ts exists',
        workdir: repo,
      });
      await waitForTerminal(store, r.attemptId);
      const lines = readFileSync(recordPath, 'utf8').trim().split('\n');
      assert.equal(lines.length, 1);
      const argv = JSON.parse(lines[0] as string) as string[];
      assert.equal(argv[argv.indexOf('--model') + 1], 'Qwen3.8-Max');
      assert.equal(argv[argv.indexOf('--reasoning-effort') + 1], 'medium');
      assert.equal(argv[argv.indexOf('--context-window') + 1], '200000');
    } finally {
      if (prevRecord === undefined) delete process.env.FAKE_RECORD_PATH;
      else process.env.FAKE_RECORD_PATH = prevRecord;
      store.close();
    }
  });

  it('pickAgent: codebuddy first, qoder fallback, null when none configured', () => {
    const store = new Store(tempDbPath());
    try {
      const dispatcher = new Dispatcher(
        store,
        new Map([
          ['codebuddy', codebuddyAdapter],
          ['qoder', { name: 'qoder', run: async () => ({ exitCode: 0, signal: null, stderr: '' }) }],
        ]),
        mkdtempSync(join(tmpdir(), 'orch-dispatch-')),
      );
      assert.equal(dispatcher.pickAgent(['codebuddy', 'qoder']), null);
      store.upsertExecutorConfig('qoder', {
        models: [{ id: 'auto', reasoning: 'high', context: '128K' }],
        defaultModel: 'auto',
      });
      assert.equal(dispatcher.pickAgent(['codebuddy', 'qoder']), 'qoder');
      store.upsertExecutorConfig('codebuddy', {
        models: [{ id: 'hy3', reasoning: 'high', context: '128K' }],
        defaultModel: 'hy3',
      });
      assert.equal(dispatcher.pickAgent(['codebuddy', 'qoder']), 'codebuddy');
    } finally {
      store.close();
    }
  });
});
