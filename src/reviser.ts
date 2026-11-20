// reviser (P1): what happens after verification fails.
// revise (same agent, ≤2) -> reroute (other agent) -> replan proposal.
// The scheduler applies the decision; this module only decides.
import type { Attempt, Task } from './store.js';
import type { VerifyResult } from './verifier.js';
import { otherAgent } from './verifier.js';

export const MAX_REVISIONS = 2;

export type ReviseDecision =
  | { action: 'revise'; agent: string; prompt: string }
  | { action: 'reroute'; agent: string; prompt: string }
  | { action: 'replan'; reason: string };

function summarizeEvidence(verify: VerifyResult): string {
  const lines: string[] = [];
  for (const c of verify.checks) {
    if (c.status === 'fail') lines.push(`- check ${c.name} FAILED: ${c.detail}`);
  }
  if (verify.review && verify.review.verdict === 'fail') {
    lines.push(`- review by ${verify.review.reviewer} FAILED: ${verify.review.notes}`);
  }
  return lines.length > 0 ? lines.join('\n') : 'verification failed with no details';
}

function failureContext(task: Task, verify: VerifyResult): string {
  return [
    `Task: ${task.title}`,
    `Contract: ${task.contract}`,
    `Acceptance: ${task.acceptance}`,
    '',
    'Previous attempt failed verification:',
    summarizeEvidence(verify),
    '',
    'Fix the issues above. Do not repeat the previous approach if it caused the failure.',
  ].join('\n');
}

export function decideNextAction(task: Task, attempt: Attempt, verify: VerifyResult): ReviseDecision {
  if (task.revisionsUsed < MAX_REVISIONS) {
    return {
      action: 'revise',
      agent: attempt.agent,
      prompt: `${task.prompt}\n\n${failureContext(task, verify)}`,
    };
  }
  if (!task.rerouted) {
    return {
      action: 'reroute',
      agent: otherAgent(attempt.agent),
      prompt: `${task.prompt}\n\n${failureContext(task, verify)}\n\nNote: the previous agent (${attempt.agent}) failed ${MAX_REVISIONS} revise rounds on this task.`,
    };
  }
  return {
    action: 'replan',
    reason: `revise x${MAX_REVISIONS} and reroute both failed verification for task ${task.key}`,
  };
}
