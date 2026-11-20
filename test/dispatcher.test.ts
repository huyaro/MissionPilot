// dispatcher tests — dispatch loop, isolation, failure, recovery.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Dispatcher, waitForTerminal, recoverInterruptedAttempts } from '../src/dispatcher.js';
import { codebuddyAdapter } from '../src/adapters/codebuddy.js';
import { makeTempGitRepo, tempDbPath, git } from './helpers.js';

const fakeBin = join(process.cwd(), 'scripts', 'fake-executor.mjs');

function setup(mode: string): { store: Store; dispatcher: Dispatcher; dataDir: string } {
  chmodSync(fakeBin, 0o755);
  process.env.ORCHESTRATOR_CODEBUDDY_BIN = fakeBin;
  process.env.FAKE_MODE = mode;
  const dataDir = mkdtempSync(join(tmpdir(), 'orch-dispatch-'));
  const store = new Store(tempDbPath());
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
});
