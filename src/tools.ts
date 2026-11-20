// MCP tool definitions + hand-written argument validation (no zod).
// INV-4: no secrets enter tool parameters or logs — these schemas take none.
import type { Store } from './store.js';
import type { Dispatcher, DispatchInput } from './dispatcher.js';

export interface ToolResult {
  text: string;
  isError: boolean;
}

export const KNOWN_AGENTS = ['codebuddy'] as const;

export const DISPATCH_TASK_SCHEMA = {
  type: 'object',
  properties: {
    agent: { type: 'string', enum: [...KNOWN_AGENTS], description: 'Executor CLI to run.' },
    task: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title.' },
        prompt: { type: 'string', description: 'Instructions for the executor.' },
      },
      required: ['title', 'prompt'],
    },
    contract: { type: 'string', description: 'Acceptance criteria the work must meet.' },
    workdir: { type: 'string', description: 'Absolute path of the git repo to work in.' },
  },
  required: ['agent', 'task', 'contract', 'workdir'],
} as const;

export const GET_ATTEMPT_SCHEMA = {
  type: 'object',
  properties: {
    attempt_id: { type: 'string', description: 'Attempt id returned by dispatch_task.' },
  },
  required: ['attempt_id'],
} as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

export function validateDispatchInput(args: unknown): DispatchInput {
  if (!isRecord(args)) throw new Error("dispatch_task: arguments must be an object");
  if (!nonEmptyString(args.agent)) throw new Error("dispatch_task: 'agent' is required");
  if (!(KNOWN_AGENTS as readonly string[]).includes(args.agent)) {
    throw new Error(`dispatch_task: unknown agent '${args.agent}' (known: ${KNOWN_AGENTS.join(', ')})`);
  }
  if (!isRecord(args.task)) throw new Error("dispatch_task: 'task' must be an object");
  if (!nonEmptyString(args.task.title)) throw new Error("dispatch_task: 'task.title' is required");
  if (!nonEmptyString(args.task.prompt)) throw new Error("dispatch_task: 'task.prompt' is required");
  if (!nonEmptyString(args.contract)) throw new Error("dispatch_task: 'contract' is required");
  if (!nonEmptyString(args.workdir)) throw new Error("dispatch_task: 'workdir' is required");
  return {
    agent: args.agent,
    task: { title: args.task.title, prompt: args.task.prompt },
    contract: args.contract,
    workdir: args.workdir,
  };
}

export function validateGetAttemptInput(args: unknown): { attemptId: string } {
  if (!isRecord(args)) throw new Error('get_attempt: arguments must be an object');
  if (!nonEmptyString(args.attempt_id)) throw new Error("get_attempt: 'attempt_id' is required");
  return { attemptId: args.attempt_id };
}

/** dispatch_task handler: validates, dispatches, returns the attempt id at once (INV-5). */
export async function handleDispatchTask(dispatcher: Dispatcher, args: unknown): Promise<ToolResult> {
  try {
    const input = validateDispatchInput(args);
    const r = await dispatcher.dispatch(input);
    return {
      isError: false,
      text: JSON.stringify({
        attempt_id: r.attemptId,
        mission_id: r.missionId,
        task_id: r.taskId,
        worktree_path: r.worktreePath,
        status: 'running',
      }),
    };
  } catch (err) {
    return { isError: true, text: err instanceof Error ? err.message : String(err) };
  }
}

/** get_attempt handler: full attempt state + events + diff summary. */
export async function handleGetAttempt(store: Store, args: unknown): Promise<ToolResult> {
  try {
    const { attemptId } = validateGetAttemptInput(args);
    const attempt = store.getAttempt(attemptId);
    if (!attempt) return { isError: true, text: `attempt not found: ${attemptId}` };
    const events = store.listEvents(attemptId).map((e) => {
      let payload: unknown = e.payload;
      try {
        payload = JSON.parse(e.payload);
      } catch {
        // keep raw string
      }
      return { seq: e.seq, type: e.type, ts: e.ts, payload };
    });
    let diffSummary: unknown = null;
    if (attempt.diffSummary) {
      try {
        diffSummary = JSON.parse(attempt.diffSummary);
      } catch {
        diffSummary = attempt.diffSummary;
      }
    }
    return {
      isError: false,
      text: JSON.stringify({
        attempt_id: attempt.id,
        task_id: attempt.taskId,
        agent: attempt.agent,
        status: attempt.status,
        exit_code: attempt.exitCode,
        stderr: attempt.stderr,
        worktree_path: attempt.worktreePath,
        diff_summary: diffSummary,
        event_count: events.length,
        events,
      }),
    };
  } catch (err) {
    return { isError: true, text: err instanceof Error ? err.message : String(err) };
  }
}
