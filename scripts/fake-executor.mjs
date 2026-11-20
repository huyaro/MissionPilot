#!/usr/bin/env node
// Fake executor CLI for tests — stands in for `codebuddy` (same arg shape:
// -p <prompt> --output-format stream-json -y). Emits stream-json lines on
// stdout, optionally writes a file into cwd, exits 0 or 1.
//
// Modes (env FAKE_MODE, or --fail / --empty flags):
//   success (default): message + tool_call + file_edit events, writes hello.ts, exit 0
//   fail:              message event, stderr text, exit 1
//   empty:             message event only, writes nothing, exit 0 (INV-3 case)
//   slow:              like success, but sleeps ~2s first
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const promptIdx = args.indexOf('-p');
const prompt = promptIdx >= 0 ? (args[promptIdx + 1] ?? '') : '';

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

if (mode === 'fail') {
  process.stderr.write('simulated failure: fake executor refused the task\n');
  process.exit(1);
}

if (mode === 'success' || mode === 'slow') {
  emit({ type: 'tool_call', tool: 'write', args: { path: 'hello.ts' } });
  writeFileSync('hello.ts', 'export const hello = () => "hi";\n');
  emit({ type: 'file_edit', path: 'hello.ts', action: 'create' });
  emit({ type: 'cost', usage: { inputTokens: 10, outputTokens: 20 } });
}

process.exit(0);
