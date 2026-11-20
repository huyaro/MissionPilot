// Shared headless-CLI runner used by every executor adapter.
// Spawns the CLI in a worktree, parses stream-json stdout into unified
// events, captures stderr (capped), maps exit code / signal.
// Supports AbortSignal: abort sends SIGTERM, then SIGKILL after a grace
// period if the child ignores it.
import { spawn } from 'node:child_process';
import type { AdapterRunResult, RunOptions } from './types.js';
import { classifyStreamLine } from './streamjson.js';

/** Keep only the tail of stderr so a chatty CLI can't grow memory unboundedly. */
const STDERR_CAP = 64 * 1024;
const KILL_GRACE_MS = 5_000;

export interface CliRunOptions extends RunOptions {
  bin: string;
  args: string[];
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

export function runCli(opts: CliRunOptions): Promise<AdapterRunResult> {
  if (opts.signal?.aborted) {
    return Promise.resolve({ exitCode: null, signal: 'SIGTERM', stderr: 'run aborted' });
  }
  return new Promise<AdapterRunResult>((resolve) => {
    let settled = false;
    const settle = (r: AdapterRunResult): void => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };

    const child = spawn(opts.bin, opts.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      let idx: number;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        const event = classifyStreamLine(line);
        if (event) opts.onEvent(event);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_CAP);
    });
    child.on('error', (err: Error) => {
      settle({ exitCode: null, signal: null, stderr: `failed to spawn ${opts.bin}: ${err.message}` });
    });
    child.on('close', (code: number | null, signal: string | null) => {
      const last = classifyStreamLine(stdoutBuf);
      if (last) opts.onEvent(last);
      settle({ exitCode: code, signal, stderr });
    });

    opts.signal?.addEventListener(
      'abort',
      () => {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
        }, KILL_GRACE_MS);
      },
      { once: true },
    );
  });
}
