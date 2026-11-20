// dispatcher: build an attempt, give it a worktree, spawn the CLI.
// INV-1: only the backend dispatches. INV-5: dispatch returns immediately;
// the run continues in the background and is polled via get_attempt.
//
// Task/mission finalization: by default (P0 single-task path) the dispatcher
// finalizes the task + mission from the attempt outcome. When the P1
// scheduler owns the task graph, construct with { finalizeTasks: false }
// and the scheduler drives task/mission transitions instead.
import { join } from 'node:path';
import { Store } from './store.js';
import type { Attempt, Task } from './store.js';
import { createWorktree, diffSummary, resolveDispatchBase } from './worktree.js';
import type { ExecutorAdapter } from './adapters/types.js';
import { appendLedger } from './ledger.js';
import { publishBoardEvent } from './bus.js';
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

export interface DispatcherOptions {
  /** False when the P1 scheduler owns task/mission status. Default true. */
  finalizeTasks?: boolean;
}

export class Dispatcher {
  private store: Store;
  private adapters: Map<string, ExecutorAdapter>;
  private dataDir: string;
  private finalizeTasks: boolean;
  private running = new Map<string, AbortController>();

  constructor(
    store: Store,
    adapters: Map<string, ExecutorAdapter>,
    dataDir: string,
    opts: DispatcherOptions = {},
  ) {
    this.store = store;
    this.adapters = adapters;
    this.dataDir = dataDir;
    this.finalizeTasks = opts.finalizeTasks ?? true;
  }

  /** P0 path: create mission + task + attempt, then start it. */
  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    const adapter = this.resolveAdapter(input.agent);
    // Throws if workdir is missing or not a git repo — before any record is made.
    // Base = integration head when it exists (DAG semantics), else repo HEAD.
    const head = await resolveDispatchBase(input.workdir);

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

    const worktreePath = await this.startAttempt(
      attempt,
      task,
      mission.id,
      adapter,
      input.workdir,
      head,
      input.task.title,
      input.task.prompt,
      input.contract,
    );
    return { attemptId: attempt.id, missionId: mission.id, taskId: task.id, worktreePath };
  }

  /**
   * P1 path: dispatch an attempt for an EXISTING task (from a plan).
   * The caller (scheduler) owns the task's status transitions.
   */
  async dispatchExistingTask(
    task: Task,
    agent: string,
    workdir: string,
    prompt: string,
    contract: string,
  ): Promise<DispatchResult> {
    const adapter = this.resolveAdapter(agent);
    const head = await resolveDispatchBase(workdir);
    const mission = this.store.getMission(task.missionId);
    if (!mission) throw new Error(`mission not found: ${task.missionId}`);
    const attempt = this.store.createAttempt({ taskId: task.id, agent });
    const worktreePath = await this.startAttempt(
      attempt,
      task,
      mission.id,
      adapter,
      workdir,
      head,
      task.title,
      prompt,
      contract,
    );
    return { attemptId: attempt.id, missionId: mission.id, taskId: task.id, worktreePath };
  }

  /** Abort a running attempt (scheduler timeout). Returns false if not running. */
  abortAttempt(attemptId: string): boolean {
    const controller = this.running.get(attemptId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  private resolveAdapter(agent: string): ExecutorAdapter {
    const adapter = this.adapters.get(agent);
    if (!adapter) {
      throw new Error(
        `unknown agent: ${agent} (known: ${[...this.adapters.keys()].join(', ')})`,
      );
    }
    return adapter;
  }

  private async startAttempt(
    attempt: Attempt,
    task: Task,
    missionId: string,
    adapter: ExecutorAdapter,
    workdir: string,
    head: string,
    title: string,
    prompt: string,
    contract: string,
  ): Promise<string> {
    const wtPath = join(this.dataDir, 'worktrees', attempt.id);
    const wt = await createWorktree(workdir, wtPath, head);
    this.store.registerWorktree({
      attemptId: attempt.id,
      repo: workdir,
      baseCommit: wt.baseCommit,
      path: wt.path,
    });
    this.store.updateAttempt(attempt.id, { worktreePath: wt.path, status: 'running' });
    this.store.updateTaskStatus(task.id, 'running');
    this.store.updateMissionStatus(missionId, 'executing');
    appendLedger(this.store, 'attempt_started', attempt.id, missionId, `${adapter.name}: ${title}`);
    publishBoardEvent({
      type: 'attempt_started',
      missionId,
      taskId: task.id,
      attemptId: attempt.id,
      summary: `${adapter.name} started: ${title}`,
    });
    log('info', 'attempt started', { attemptId: attempt.id, agent: adapter.name, worktree: wt.path });

    const controller = new AbortController();
    this.running.set(attempt.id, controller);
    const fullPrompt = [`Task: ${title}`, '', prompt, '', 'Acceptance contract:', contract].join('\n');
    // Background run — dispatch returns without awaiting it (INV-5).
    void this.runAttempt(attempt.id, task.id, missionId, adapter, fullPrompt, wt.path, controller);
    return wt.path;
  }

  private async runAttempt(
    attemptId: string,
    taskId: string,
    missionId: string,
    adapter: ExecutorAdapter,
    prompt: string,
    worktreePath: string,
    controller: AbortController,
  ): Promise<void> {
    try {
      const result = await adapter.run({
        prompt,
        cwd: worktreePath,
        signal: controller.signal,
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
      appendLedger(
        this.store,
        'attempt_finished',
        attemptId,
        missionId,
        `${adapter.name} ${failed ? 'failed' : 'done'} (exit ${result.exitCode})`,
      );
      publishBoardEvent({
        type: 'attempt_finished',
        missionId,
        taskId,
        attemptId,
        summary: `${adapter.name} ${failed ? 'failed' : 'done'} (exit ${result.exitCode})`,
      });
      if (this.finalizeTasks) {
        // P0: one task per mission, so task + mission follow the attempt.
        this.store.updateTaskStatus(taskId, failed ? 'failed' : 'done');
        this.store.updateMissionStatus(missionId, failed ? 'failed' : 'done');
      }
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
      appendLedger(
        this.store,
        'attempt_finished',
        attemptId,
        missionId,
        `${adapter.name} crashed: ${message}`,
      );
      publishBoardEvent({
        type: 'attempt_finished',
        missionId,
        taskId,
        attemptId,
        summary: `${adapter.name} crashed: ${message}`,
      });
      if (this.finalizeTasks) {
        this.store.updateTaskStatus(taskId, 'failed');
        this.store.updateMissionStatus(missionId, 'failed');
      }
      log('error', 'attempt crashed', { attemptId, error: message });
    } finally {
      this.running.delete(attemptId);
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
