// Adapter interface: every executor CLI (codebuddy, qoder, ...) is spawned
// headless and speaks stream-json; the adapter turns its output into unified
// events the dispatcher stores. INV-1: only the backend spawns CLIs.
export type AdapterEventType = 'message' | 'tool_call' | 'file_edit' | 'cost';

export interface UnifiedEvent {
  type: AdapterEventType;
  payload: unknown;
  ts: string;
}

export interface AdapterRunResult {
  /** Process exit code; null when the process never started or died by signal. */
  exitCode: number | null;
  signal: string | null;
  /** Full stderr, capped by the adapter (see STDERR_CAP). */
  stderr: string;
}

export interface RunOptions {
  prompt: string;
  /** Working directory — always the attempt's worktree (INV-2). */
  cwd: string;
  onEvent: (event: UnifiedEvent) => void;
  /** Abort the run (scheduler timeout). The adapter kills the child. */
  signal?: AbortSignal;
}

export interface ExecutorAdapter {
  readonly name: string;
  run(opts: RunOptions): Promise<AdapterRunResult>;
}
