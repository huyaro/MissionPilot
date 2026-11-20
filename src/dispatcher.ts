// dispatcher: build an attempt, give it a worktree, spawn the CLI.
// INV-1: only the backend dispatches. INV-5: dispatch returns immediately;
// the run continues in the background and is polled via get_attempt.
import { join } from 'node:path';
import { Store } from './store.js';
import type { Attempt } from './store.js';
import { createWorktree, diffSummary, resolveHeadCommit } from './worktree.js';
import type { ExecutorAdapter } from './adapters/types.js';
import { log } from './log.js';

export interface DispatchInput {
  agent: string;
  task: { title: string; prompt: string };
  contract: string;
  workdir: string;
  /** Which brain ordered this; stdio (Codex) defaults to 'codex'. */
  source?: 'codex' | 'chatgpt';
}

export interface DispatchResult {
  attemptId: string;
  missionId: string;
  taskId: string;
  worktreePath: string;
}

export class Dispatcher {
  private store: Store;
  private adapters: Map<string, ExecutorAdapter>;
  private dataDir: string;

  constructor(store: Store, adapters: Map<string, ExecutorAdapter>, dataDir: string) {
    this.store = store;
    this.adapters = adapters;
    this.dataDir = dataDir;
  }

  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    const adapter = this.adapters.get(input.agent);
    if (!adapter) {
      throw new Error(
        `unknown agent: ${input.agent} (known: ${[...this.adapters.keys()].join(', ')})`,
      );
    }
    // Throws if workdir is missing or not a git repo — before any record is made.
    const head = await resolveHeadCommit(input.workdir);

    const { mission, task, attempt } = this.store.runInTransaction(() => {
      const mission = this.store.createMission({
        goal: input.task.title,
        repo: input.workdir,
        source: input.source ?? 'codex',
      });
      const task = this.store.createTask({
        missionId: mission.id,
        key: 'task-1',
        title: input.task.title,
        contract: input.contract,
      });
      const attempt = this.store.createAttempt({ taskId: task.id, agent: input.agent });
      return { mission, task, attempt };
    });

    const wtPath = join(this.dataDir, 'worktrees', attempt.id);
    const wt = await createWorktree(input.workdir, wtPath, head);
    this.store.registerWorktree({
      attemptId: attempt.id,
      repo: input.workdir,
      baseCommit: wt.baseCommit,
      path: wt.path,
    });
    this.store.updateAttempt(attempt.id, { worktreePath: wt.path, status: 'running' });
    this.store.updateTaskStatus(task.id, 'running');
    this.store.updateMissionStatus(mission.id, 'executing');
    log('info', 'attempt started', { attemptId: attempt.id, agent: input.agent, worktree: wt.path });

    // Background run — dispatch returns without awaiting it (INV-5).
    void this.runAttempt(attempt.id, task.id, mission.id, adapter, input, wt.path);
    return { attemptId: attempt.id, missionId: mission.id, taskId: task.id, worktreePath: wt.path };
  }

  private async runAttempt(
    attemptId: string,
    taskId: string,
    missionId: string,
    adapter: ExecutorAdapter,
    input: DispatchInput,
    worktreePath: string,
  ): Promise<void> {
    const prompt = [
      `Task: ${input.task.title}`,
      '',
      input.task.prompt,
      '',
      'Acceptance contract:',
      input.contract,
    ].join('\n');
    try {
      const result = await adapter.run({
        prompt,
        cwd: worktreePath,
        onEvent: (e) => this.store.addEvent(attemptId, e.type, e.payload),
      });
      const diff = await diffSummary(worktreePath).catch(() => null);
      const failed = result.exitCode !== 0 || result.signal !== null;
      this.store.updateAttempt(attemptId, {
        status: failed ? 'failed' : 'done',
        exitCode: result.exitCode,
        stderr: result.stderr === '' ? null : result.stderr,
        diffSummary: diff ? JSON.stringify(diff) : null,
      });
      // P0: one task per mission, so task + mission follow the attempt.
      // P1's scheduler owns multi-task mission status.
      this.store.updateTaskStatus(taskId, failed ? 'failed' : 'done');
      this.store.updateMissionStatus(missionId, failed ? 'failed' : 'done');
      log('info', 'attempt finished', {
        attemptId,
        status: failed ? 'failed' : 'done',
        exitCode: result.exitCode,
      });
    } catch (err) {
      // The adapter threw unexpectedly — record an explicit failure (INV-3),
      // never leave the attempt stuck in 'running'.
      const message = err instanceof Error ? err.message : String(err);
      this.store.updateAttempt(attemptId, { status: 'failed', stderr: `dispatcher error: ${message}` });
      this.store.updateTaskStatus(taskId, 'failed');
      this.store.updateMissionStatus(missionId, 'failed');
      log('error', 'attempt crashed', { attemptId, error: message });
    }
  }
}

/** Poll until the attempt reaches a terminal state (test helper; also used by P1). */
export async function waitForTerminal(
  store: Store,
  attemptId: string,
  timeoutMs = 30_000,
): Promise<Attempt> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const attempt = store.getAttempt(attemptId);
    if (!attempt) throw new Error(`attempt not found: ${attemptId}`);
    if (attempt.status === 'done' || attempt.status === 'failed') return attempt;
    if (Date.now() > deadline) throw new Error(`timed out waiting for attempt ${attemptId}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Startup recovery (§3 of the architecture doc): attempts still 'running'
 * when the backend restarts are marked failed with an explicit note —
 * never silently replayed, never left stuck. Their worktrees are kept
 * for inspection.
 */
export function recoverInterruptedAttempts(store: Store): number {
  const running = store.listRunningAttempts();
  for (const attempt of running) {
    store.updateAttempt(attempt.id, {
      status: 'failed',
      stderr:
        'orchestrator restarted while this attempt was running; ' +
        'result unknown — inspect the worktree before retrying.',
    });
    const task = store.getTask(attempt.taskId);
    if (task) store.updateTaskStatus(task.id, 'failed');
  }
  if (running.length > 0) {
    log('warn', 'recovered interrupted attempts', { count: running.length });
  }
  return running.length;
}
