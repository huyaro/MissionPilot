#!/usr/bin/env node
// Fake executor CLI for tests — stands in for `codebuddy` (same arg shape:
// -p <prompt> --output-format stream-json -y). Emits stream-json lines on
// stdout, optionally writes a file into cwd, exits 0 or 1.
//
// Modes (env FAKE_MODE, or --fail / --empty flags):
//   success (default): message + tool_call + file_edit events, writes hello.ts, exit 0
//   fail:              message event, stderr text, exit 1
//   fail-once:        first spawn fails, later spawns succeed (marker in
//                      tmpdir, keyed by FAKE_ONCE_KEY; deterministic revise
//                      test without mid-flight env flips)
//   empty:             message event only, writes nothing, exit 0 (INV-3 case)
//   slow:              like success, but sleeps ~2s first
//   review-fail:       reviewer runs emit {"verdict":"fail",...} instead of pass
//   review-modify:     reviewer runs write a file, then emit a pass verdict
//                      (the verifier must reject a reviewer that writes)
// Reviewer runs are detected by the prompt ("code reviewer"); maker runs
// never emit verdicts.
import { writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const promptIdx = args.indexOf('-p');
const prompt = promptIdx >= 0 ? (args[promptIdx + 1] ?? '') : '';

// Test hook: when FAKE_RECORD_PATH is set, append this spawn's argv (one
// JSON array per line) so tests can assert which flags the adapter passed.
if (process.env.FAKE_RECORD_PATH) {
  appendFileSync(process.env.FAKE_RECORD_PATH, JSON.stringify(args) + '\n');
}

let mode = process.env.FAKE_MODE ?? 'success';
if (args.includes('--fail')) mode = 'fail';
if (args.includes('--empty')) mode = 'empty';
if (args.includes('--slow')) mode = 'slow';

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

if (mode === 'slow') {
  await new Promise((r) => setTimeout(r, 2000));
}

emit({ type: 'message', content: `fake executor received prompt: ${prompt.slice(0, 80)}` });

// Reviewer runs are recognised by the review prompt (the verifier asks for
// a JSON verdict). A reviewer never writes task files; review-modify mode
// deliberately writes one so the verifier can reject it.
if (prompt.includes('code reviewer')) {
  if (mode === 'review-modify') {
    writeFileSync('reviewer-touched.txt', 'the reviewer wrote this\n');
  }
  const verdict = mode === 'review-fail' ? 'fail' : 'pass';
  const notes = mode === 'review-fail' ? 'contract not met' : 'looks good';
  emit({ type: 'message', content: JSON.stringify({ verdict, notes }) });
  process.exit(0);
}

if (mode === 'fail-once') {
  const marker = join(tmpdir(), `orch-fake-failed-once-${process.env.FAKE_ONCE_KEY ?? 'default'}`);
  if (!existsSync(marker)) {
    writeFileSync(marker, 'x');
    process.stderr.write('simulated failure: fail-once first run\n');
    process.exit(1);
  }
  mode = 'success';
}

if (mode === 'fail') {
  process.stderr.write('simulated failure: fake executor refused the task\n');
  process.exit(1);
}

if (mode === 'success' || mode === 'slow') {
  emit({ type: 'tool_call', tool: 'write', args: { path: 'hello.ts' } });
  // Content carries the prompt, so two tasks with different prompts produce
  // different diffs even when the second worktree is based on the first
  // task's merged result (DAG order: B builds on A's integration head).
  writeFileSync('hello.ts', `export const hello = () => "hi";\n// task: ${prompt.slice(0, 60)}\n`);
  emit({ type: 'file_edit', path: 'hello.ts', action: 'create' });
  emit({ type: 'cost', usage: { inputTokens: 10, outputTokens: 20 } });
}

process.exit(0);
