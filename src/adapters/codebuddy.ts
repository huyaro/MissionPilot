// CodeBuddy adapter (P0).
//
// Spawns: codebuddy -p <prompt> --output-format stream-json -y
// (per the P0 draft, verified against the official Headless docs 2026-11-19).
// `-y` alone may still block HIGH/CRITICAL commands, so inside the isolated
// worktree we also set CODEBUDDY_IS_SANDBOX=1 (INV-2: bypass only inside the
// worktree). Set ORCHESTRATOR_CODEBUDDY_SANDBOX=0 to disable that.
// The binary is overridable via ORCHESTRATOR_CODEBUDDY_BIN (tests point it
// at scripts/fake-executor.mjs; the real binary is only on the user's Mac).
import type { AdapterRunResult, ExecutorAdapter, RunOptions } from './types.js';
import { runCli } from './cli.js';

export const codebuddyAdapter: ExecutorAdapter = {
  name: 'codebuddy',

  async run(opts: RunOptions): Promise<AdapterRunResult> {
    const bin = process.env.ORCHESTRATOR_CODEBUDDY_BIN ?? 'codebuddy';
    const sandbox = process.env.ORCHESTRATOR_CODEBUDDY_SANDBOX !== '0';
    const args: string[] = ['-p', opts.prompt, '--output-format', 'stream-json', '-y'];
    // --model is in the official CLI reference ("Prompt and model" table:
    // "Set the session model by alias or full name"). Reasoning/context
    // flags are NOT documented for codebuddy, so they are stored in config
    // but never passed — the dispatcher logs that (see dispatcher.ts).
    if (opts.model) args.push('--model', opts.model.id);
    return runCli({
      ...opts,
      bin,
      args,
      env: sandbox ? { CODEBUDDY_IS_SANDBOX: '1' } : {},
    });
  },
};
