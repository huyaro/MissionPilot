// CodeBuddy adapter (P0).
//
// Spawns: codebuddy -p <prompt> --output-format stream-json -y
// (per the P0 draft, verified against the official Headless docs 2026-11-19).
// `-y` alone may still block HIGH/CRITICAL commands, so inside the isolated
// worktree we also set CODEBUDDY_IS_SANDBOX=1 (INV-2: bypass only inside the
// worktree). Set ORCHESTRATOR_CODEBUDDY_SANDBOX=0 to disable that.
// The binary is overridable via ORCHESTRATOR_CODEBUDDY_BIN (tests point it
// at scripts/fake-executor.mjs; the real binary is only on the user's Mac).
import { spawn } from 'node:child_process';
import type { AdapterRunResult, ExecutorAdapter, RunOptions } from './types.js';
import { classifyStreamLine } from './streamjson.js';

/** Keep only the tail of stderr so a chatty CLI can't grow memory unboundedly. */
const STDERR_CAP = 64 * 1024;

export const codebuddyAdapter: ExecutorAdapter = {
  name: 'codebuddy',

  async run(opts: RunOptions): Promise<AdapterRunResult> {
    const bin = process.env.ORCHESTRATOR_CODEBUDDY_BIN ?? 'codebuddy';
    const sandbox = process.env.ORCHESTRATOR_CODEBUDDY_SANDBOX !== '0';
    const env = { ...process.env };
    if (sandbox) env.CODEBUDDY_IS_SANDBOX = '1';

    return new Promise<AdapterRunResult>((resolve) => {
      let settled = false;
      const settle = (r: AdapterRunResult): void => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };

      const child = spawn(bin, ['-p', opts.prompt, '--output-format', 'stream-json', '-y'], {
        cwd: opts.cwd,
        env,
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
        settle({ exitCode: null, signal: null, stderr: `failed to spawn codebuddy: ${err.message}` });
      });
      child.on('close', (code: number | null, signal: string | null) => {
        const last = classifyStreamLine(stdoutBuf);
        if (last) opts.onEvent(last);
        settle({ exitCode: code, signal, stderr });
      });
    });
  },
};
