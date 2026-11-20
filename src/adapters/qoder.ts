// Qoder adapter (P1).
//
// Spawns: qoder -p <prompt> --output-format stream-json --yolo
// (per the P0 draft, verified against the official CLI reference 2026-11-19).
// Under -p, "ask" becomes "deny", so editing needs --yolo
// (= --permission-mode bypass_permissions). Even with --yolo, protected
// paths (.git, shell startup files, .mcp.json) still need approval — the
// adapter surfaces that as a failed attempt with stderr, never as success.
// The binary is overridable via ORCHESTRATOR_QODER_BIN (tests point it at
// scripts/fake-executor.mjs; the real binary is only on the user's Mac).
// If the user has the domestic build, set ORCHESTRATOR_QODER_BIN=qodercn.
import type { AdapterRunResult, ExecutorAdapter, RunOptions } from './types.js';
import { runCli } from './cli.js';

export const qoderAdapter: ExecutorAdapter = {
  name: 'qoder',

  async run(opts: RunOptions): Promise<AdapterRunResult> {
    const bin = process.env.ORCHESTRATOR_QODER_BIN ?? 'qoder';
    return runCli({
      ...opts,
      bin,
      args: ['-p', opts.prompt, '--output-format', 'stream-json', '--yolo'],
      env: {},
    });
  },
};
