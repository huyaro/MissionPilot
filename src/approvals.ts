// Approvals (P3): the human decision point for anything that leaves the
// local loop — replan proposals and pushing the integration branch.
// INV-7: push/PR must be human-approved before execution. Approving a
// 'push' approval executes `git push origin orchestrator/integration`
// ONLY when the repo has an origin remote; with no remote configured the
// approval is recorded as approved and the push is honestly reported as
// deferred (this repo runs local-git-only until the user gives a remote).
// Rejecting requires a reason, and every decision lands in the ledger.
import { execFile } from 'node:child_process';
import type { Store, Approval } from './store.js';
import { appendLedger } from './ledger.js';
import { publishBoardEvent } from './bus.js';

export interface PushOutcome {
  pushed: boolean;
  note: string;
}

export function createReplanApproval(
  store: Store,
  missionId: string,
  taskId: string,
  reason: string,
): Approval {
  const approval = store.createApproval({
    kind: 'replan',
    missionId,
    taskId,
    summary: `Replan proposed for task ${taskId}: ${reason}`,
  });
  appendLedger(store, 'approval_created', approval.id, missionId, approval.summary);
  publishBoardEvent({
    type: 'approval_created',
    missionId,
    taskId,
    approvalId: approval.id,
    summary: approval.summary,
  });
  return approval;
}

export function createPushApproval(store: Store, missionId: string, repo: string): Approval {
  const approval = store.createApproval({
    kind: 'push',
    missionId,
    summary: `Push orchestrator/integration for ${repo} (mission ${missionId})`,
  });
  appendLedger(store, 'approval_created', approval.id, missionId, approval.summary);
  publishBoardEvent({
    type: 'approval_created',
    missionId,
    approvalId: approval.id,
    summary: approval.summary,
  });
  return approval;
}

/** Decide an approval. Rejecting requires a reason. */
export function decideApproval(
  store: Store,
  id: string,
  decision: 'approved' | 'rejected',
  reason: string | null,
): { approval: Approval } {
  if (decision === 'rejected' && !reason?.trim()) {
    throw new Error('rejecting an approval requires a reason');
  }
  const approval = store.decideApproval(id, decision, reason);
  appendLedger(
    store,
    'approval_decided',
    approval.id,
    approval.missionId,
    `${approval.kind} ${decision}${reason ? `: ${reason}` : ''}`,
  );
  publishBoardEvent({
    type: 'approval_decided',
    missionId: approval.missionId,
    approvalId: approval.id,
    summary: `${approval.kind} ${decision}`,
  });
  // An approved 'push' does not push here: the board API runs
  // executeApprovedPush so the side effect is explicit and testable.
  return { approval };
}

/** Execute the push for an approved 'push' approval, if a remote exists.
 * Split from decideApproval so the caller (board API) controls when the
 * side effect runs; returns a plain outcome, never throws on git failure. */
export async function executeApprovedPush(
  store: Store,
  approvalId: string,
): Promise<PushOutcome> {
  const approval = store.getApproval(approvalId);
  if (!approval) return { pushed: false, note: `approval not found: ${approvalId}` };
  if (approval.kind !== 'push' || approval.status !== 'approved') {
    return { pushed: false, note: 'approval is not an approved push' };
  }
  const mission = store.getMission(approval.missionId);
  if (!mission) return { pushed: false, note: 'mission not found' };
  const hasRemote = await gitHasOrigin(mission.repo);
  if (!hasRemote) {
    return { pushed: false, note: 'push deferred: no remote configured' };
  }
  try {
    await runGit(mission.repo, ['push', 'origin', 'orchestrator/integration']);
    return { pushed: true, note: 'pushed orchestrator/integration to origin' };
  } catch (err) {
    return {
      pushed: false,
      note: `push failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 60_000 }, (err, stdout) => {
      if (err) reject(new Error(err.message));
      else resolve(stdout);
    });
  });
}

async function gitHasOrigin(cwd: string): Promise<boolean> {
  try {
    const out = await runGit(cwd, ['remote', 'get-url', 'origin']);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}
