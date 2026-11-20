// CodeBuddy adapter tests — run against scripts/fake-executor.mjs
// (the real codebuddy CLI is not installed on this VM; Mac verification
// is listed in MILESTONES.md §8).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codebuddyAdapter } from '../src/adapters/codebuddy.js';
import type { UnifiedEvent } from '../src/adapters/types.js';

const fakeBin = join(process.cwd(), 'scripts', 'fake-executor.mjs');

before(() => {
  chmodSync(fakeBin, 0o755);
});

function withFakeEnv(mode: string | null, fn: () => Promise<void>): Promise<void> {
  const prevBin = process.env.ORCHESTRATOR_CODEBUDDY_BIN;
  const prevMode = process.env.FAKE_MODE;
  process.env.ORCHESTRATOR_CODEBUDDY_BIN = fakeBin;
  if (mode === null) delete process.env.FAKE_MODE;
  else process.env.FAKE_MODE = mode;
  return fn().finally(() => {
    if (prevBin === undefined) delete process.env.ORCHESTRATOR_CODEBUDDY_BIN;
    else process.env.ORCHESTRATOR_CODEBUDDY_BIN = prevBin;
    if (prevMode === undefined) delete process.env.FAKE_MODE;
    else process.env.FAKE_MODE = prevMode;
  });
}

describe('codebuddy adapter', () => {
  it('success: parses stream-json events and writes the file', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'orch-adapter-'));
    const events: UnifiedEvent[] = [];
    await withFakeEnv('success', async () => {
      const result = await codebuddyAdapter.run({
        prompt: 'create hello.ts',
        cwd,
        onEvent: (e) => events.push(e),
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.signal, null);
      assert.equal(result.stderr, '');
    });
    assert.ok(existsSync(join(cwd, 'hello.ts')));
    const types = events.map((e) => e.type);
    assert.ok(types.includes('message'));
    assert.ok(types.includes('tool_call'));
    assert.ok(types.includes('file_edit'));
    assert.ok(types.includes('cost'));
    // Prompt is passed through to the executor.
    const first = events[0].payload as { content?: string };
    assert.match(first.content ?? '', /create hello\.ts/);
  });

  it('fail: non-zero exit + stderr are reported explicitly (INV-3)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'orch-adapter-'));
    await withFakeEnv('fail', async () => {
      const result = await codebuddyAdapter.run({
        prompt: 'do it',
        cwd,
        onEvent: () => {},
      });
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /simulated failure/);
    });
  });

  it('empty: exit 0 with no file written (verifier must catch this in P1)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'orch-adapter-'));
    await withFakeEnv('empty', async () => {
      const result = await codebuddyAdapter.run({
        prompt: 'do it',
        cwd,
        onEvent: () => {},
      });
      assert.equal(result.exitCode, 0);
    });
    assert.equal(existsSync(join(cwd, 'hello.ts')), false);
  });

  it('missing binary: spawn failure is an explicit result, not a crash', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'orch-adapter-'));
    const prev = process.env.ORCHESTRATOR_CODEBUDDY_BIN;
    process.env.ORCHESTRATOR_CODEBUDDY_BIN = '/nonexistent/codebuddy';
    try {
      const result = await codebuddyAdapter.run({ prompt: 'x', cwd, onEvent: () => {} });
      assert.equal(result.exitCode, null);
      assert.match(result.stderr, /failed to spawn \/nonexistent\/codebuddy/);
    } finally {
      if (prev === undefined) delete process.env.ORCHESTRATOR_CODEBUDDY_BIN;
      else process.env.ORCHESTRATOR_CODEBUDDY_BIN = prev;
    }
  });
});
