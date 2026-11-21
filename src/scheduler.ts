// scheduler (P1): drives the task graph for active missions.
// One tick per mission: timeouts -> verify finished attempts -> apply the
// reviser decision -> dispatch ready tasks (up to the concurrency limit) ->
// merge verified tasks in DAG order -> close out the mission.
// The scheduler owns ALL task/mission transitions (the dispatcher is built
// with finalizeTasks: false in P1 mode).
import { Store } from './store.js';
import type { Attempt, Mission, Task } from './store.js';
import { Dispatcher } from './dispatcher.js';
import { Verifier } from './verifier.js';
import type { VerifyResult } from './verifier.js';
import { decideNextAction } from './reviser.js';
import { appendLedger } from './ledger.js';
import { publishBoardEvent } from './bus.js';
import { createPushApproval, createReplanApproval } from './approvals.js';
import {
  commitWorktree,
  ensureIntegrationBranch,
  mergeCommitToIntegration,
  removeWorktree,
} from './worktree.js';
import { log } from './log.js';

export interface SchedulerOptions {
  /** Max concurrent running attempts per mission. Default 2. */
  concurrencyPerMission?: number;
  /** Kill a running attempt older than this. Default 30 minutes. */
  attemptTimeoutMs?: number;
}

/**
 * First attempt of a task prefers codebuddy (the P0 executor), then qoder.
 * The dispatcher only picks an agent that has at least one configured
 * model (see dispatcher.pickAgent) — an unconfigured agent is never a
 * candidate, and the task fails with a clear ledger reason instead of
 * silently stalling.
 */
const PREFERRED_AGENTS = ['codebuddy', 'qoder'];

export class Scheduler {
  private store: Store;
  private dispatcher: Dispatcher;
  private verifier: Verifier;
  private concurrencyPerMission: number;
  private attemptTimeoutMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(store: Store, dispatcher: Dispatcher, verifier: Verifier, opts: SchedulerOptions = {}) {
    this.store = store;
    this.dispatcher = dispatcher;
    this.verifier = verifier;
    this.concurrencyPerMission = opts.concurrencyPerMission ?? 2;
    this.attemptTimeoutMs = opts.attemptTimeoutMs ?? 30 * 60 * 1000;
  }

  start(intervalMs = 5_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => {
        log('error', 'scheduler tick failed', { error: err instanceof Error ? err.message : String(err) });
      });
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return; // never overlap ticks
    this.ticking = true;
    try {
      for (const mission of this.store.listActiveMissions()) {
        await this.tickMission(mission);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async tickMission(mission: Mission): Promise<void> {
    const tasks = this.store.listTasksByMission(mission.id);

    // 1. Timeouts: abort running attempts older than the limit.
    for (const task of tasks) {
      if (task.status !== 'running') continue;
      const attempt = this.latestAttempt(task.id);
      if (!attempt || attempt.status !== 'running') continue;
      if (Date.now() - Date.parse(attempt.createdAt) > this.attemptTimeoutMs) {
        log('warn', 'attempt timed out, aborting', { attemptId: attempt.id, task: task.key });
        this.dispatcher.abortAttempt(attempt.id);
      }
    }

    // 2. Verify finished attempts.
    for (const task of tasks) {
      if (task.status !== 'running') continue;
      const attempt = this.latestAttempt(task.id);
      if (!attempt || (attempt.status !== 'done' && attempt.status !== 'failed')) continue;
      await this.verifyAndDecide(mission, task, attempt);
    }

    // 3. Merge verified-done tasks in DAG order — BEFORE dispatching, so a
    // dependent task's worktree is based on the freshly merged integration
    // head (DAG semantics: B builds on A's merged result). A merge failure
    // marks the task failed, so its dependents are never dispatched.
    await this.mergeDoneTasks(mission);

    // 4. Dispatch ready tasks (deps done), up to the concurrency limit.
    // Re-read task states: verify/merge above changed them, and the
    // snapshot from the top of the tick is stale.
    const freshTasks = this.store.listTasksByMission(mission.id);
    const freshByKey = new Map(freshTasks.map((t) => [t.key, t]));
    const running = freshTasks.filter((t) => t.status === 'running').length;
    let slots = this.concurrencyPerMission - running;
    if (slots > 0) {
      for (const task of freshTasks) {
        if (slots <= 0) break;
        if (task.status !== 'pending') continue;
        if (!this.depsDone(task, freshByKey)) continue;
        this.store.updateTaskStatus(task.id, 'ready');
        this.store.updateTaskStatus(task.id, 'leased');
        const agent = this.dispatcher.pickAgent(PREFERRED_AGENTS);
        if (!agent) {
          // Fail-closed: no executor has a configured model, so nothing
          // may run. Failing (with a ledger reason) beats a silent stall.
          this.store.updateTaskStatus(task.id, 'failed');
          appendLedger(
            this.store,
            'task_failed',
            task.id,
            mission.id,
            'no executor has configured models — add models in Settings',
          );
          log('error', 'no dispatchable executor', { missionId: mission.id, task: task.key });
          continue;
        }
        await this.dispatcher.dispatchExistingTask(
          task,
          agent,
          mission.repo,
          task.prompt,
          task.contract,
        );
        slots--;
      }
    }

    // 5. Close out the mission.
    const finalTasks = this.store.listTasksByMission(mission.id);
    if (finalTasks.length > 0 && finalTasks.every((t) => t.status === 'done')) {
      this.store.updateMissionStatus(mission.id, 'done');
      appendLedger(this.store, 'mission_done', mission.id, mission.id, mission.goal);
      publishBoardEvent({ type: 'mission_done', missionId: mission.id, summary: mission.goal });
      // INV-7: the integration branch is ready to push only after a human
      // approves it in the board.
      createPushApproval(this.store, mission.id, mission.repo);
      log('info', 'mission done', { missionId: mission.id });
    } else if (
      finalTasks.some((t) => t.status === 'failed') &&
      finalTasks.every((t) => t.status === 'done' || t.status === 'failed')
    ) {
      this.store.updateMissionStatus(mission.id, 'failed');
      appendLedger(this.store, 'mission_failed', mission.id, mission.id, mission.goal);
      publishBoardEvent({ type: 'mission_failed', missionId: mission.id, summary: mission.goal });
      log('info', 'mission failed', { missionId: mission.id });
    }
  }

  private async verifyAndDecide(mission: Mission, task: Task, attempt: Attempt): Promise<void> {
    this.store.updateTaskStatus(task.id, 'verifying');
    let verify: VerifyResult;
    if (attempt.status === 'failed') {
      // Execution failure (non-zero exit, spawn error, timeout): treat it
      // through the same revise/reroute/replan path as a verification
      // failure, with the execution error as the evidence.
      verify = {
        passed: false,
        checks: [
          {
            name: 'execution',
            status: 'fail',
            detail: `attempt failed: exit_code=${attempt.exitCode} stderr=${(attempt.stderr ?? '').slice(0, 500)}`,
          },
        ],
        review: null,
      };
      this.store.updateAttempt(attempt.id, { evidence: JSON.stringify(verify) });
    } else {
      verify = await this.verifier.verify(attempt, task);
    }
    appendLedger(
      this.store,
      'attempt_verified',
      attempt.id,
      mission.id,
      `${attempt.agent} ${verify.passed ? 'passed' : 'failed'}: ${task.title}`,
    );
    publishBoardEvent({
      type: 'attempt_verified',
      missionId: mission.id,
      taskId: task.id,
      attemptId: attempt.id,
      summary: `${attempt.agent} ${verify.passed ? 'passed' : 'failed'}: ${task.title}`,
    });
    if (verify.passed) {
      this.store.updateTaskStatus(task.id, 'done');
      return;
    }
    const decision = decideNextAction(task, attempt, verify);
    if (decision.action === 'revise' || decision.action === 'reroute') {
      const agent = this.dispatcher.pickAgent([decision.agent]);
      if (!agent) {
        // The decided agent has no configured model — it cannot run.
        // Fail the task with a clear reason instead of dispatching to
        // a model outside the user's configured range.
        this.store.updateTaskStatus(task.id, 'failed');
        appendLedger(
          this.store,
          'task_failed',
          task.id,
          mission.id,
          `${decision.agent} has no configured models — add models in Settings`,
        );
        log('error', 'decided agent is not dispatchable', { task: task.key, agent: decision.agent });
        return;
      }
      if (decision.action === 'revise') {
        this.store.updateTaskFields(task.id, { revisionsUsed: task.revisionsUsed + 1 });
      } else {
        this.store.updateTaskFields(task.id, { rerouted: true });
      }
      await this.dispatcher.dispatchExistingTask(
        task,
        agent,
        mission.repo,
        decision.prompt,
        task.contract,
      );
    } else {
      this.store.createReplanProposal({
        missionId: mission.id,
        taskId: task.id,
        reason: decision.reason,
      });
      createReplanApproval(this.store, mission.id, task.id, decision.reason);
      this.store.updateTaskStatus(task.id, 'failed');
      log('warn', 'task failed terminally, replan proposed', { task: task.key, reason: decision.reason });
    }
  }

  private async mergeDoneTasks(mission: Mission): Promise<void> {
    const tasks = this.topoSort(this.store.listTasksByMission(mission.id));
    for (const task of tasks) {
      if (task.status !== 'done') continue;
      const attempt = this.latestAttempt(task.id);
      if (!attempt || attempt.status !== 'done' || !attempt.worktreePath) continue;
      const wt = this.store.getWorktreeByAttempt(attempt.id);
      if (!wt || wt.status !== 'active') continue; // already merged
      try {
        const sha = await commitWorktree(
          attempt.worktreePath,
          `attempt ${attempt.id}: ${task.title}`,
        );
        await ensureIntegrationBranch(mission.repo, wt.baseCommit);
        await mergeCommitToIntegration(
          mission.repo,
          sha,
          `merge attempt ${attempt.id}: ${task.title}`,
        );
        this.store.updateWorktree(wt.id, { status: 'merged', mergedCommit: sha });
        await removeWorktree(mission.repo, attempt.worktreePath).catch(() => undefined);
        appendLedger(
          this.store,
          'attempt_merged',
          attempt.id,
          mission.id,
          `merged ${sha.slice(0, 12)}: ${task.title}`,
        );
        publishBoardEvent({
          type: 'attempt_merged',
          missionId: mission.id,
          taskId: task.id,
          attemptId: attempt.id,
          summary: `merged: ${task.title}`,
        });
        log('info', 'attempt merged', { attemptId: attempt.id, task: task.key, commit: sha });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.store.createReplanProposal({
          missionId: mission.id,
          taskId: task.id,
          reason: `merge failed: ${message}`,
        });
        createReplanApproval(this.store, mission.id, task.id, `merge failed: ${message}`);
        this.store.updateTaskStatus(task.id, 'failed');
        log('error', 'merge failed, task failed', { task: task.key, error: message });
      }
    }
  }

  private latestAttempt(taskId: string): Attempt | null {
    const attempts = this.store.listAttemptsByTask(taskId);
    return attempts.length > 0 ? attempts[attempts.length - 1] : null;
  }

  private depsDone(task: Task, byKey: Map<string, Task>): boolean {
    return task.dependsOn.every((key) => byKey.get(key)?.status === 'done');
  }

  /** Topological order of the mission's tasks (Kahn; plan validation already rejects cycles). */
  private topoSort(tasks: Task[]): Task[] {
    const byKey = new Map(tasks.map((t) => [t.key, t]));
    const inDegree = new Map(tasks.map((t) => [t.key, t.dependsOn.length]));
    const queue = tasks.filter((t) => t.dependsOn.length === 0).map((t) => t.key);
    const out: Task[] = [];
    while (queue.length > 0) {
      const key = queue.shift() as string;
      const task = byKey.get(key);
      if (task) out.push(task);
      for (const t of tasks) {
        if (t.dependsOn.includes(key)) {
          inDegree.set(t.key, (inDegree.get(t.key) ?? 0) - 1);
          if (inDegree.get(t.key) === 0) queue.push(t.key);
        }
      }
    }
    return out.length === tasks.length ? out : tasks;
  }
}
