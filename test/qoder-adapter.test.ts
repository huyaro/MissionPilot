// Qoder adapter tests — same fake executor, different binary env var.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { qoderAdapter } from '../src/adapters/qoder.js';
import type { UnifiedEvent } from '../src/adapters/types.js';

const fakeBin = join(process.cwd(), 'scripts', 'fake-executor.mjs');

before(() => {
  chmodSync(fakeBin, 0o755);
});

function withFakeEnv(mode: string, fn: () => Promise<void>): Promise<void> {
  const prevBin = process.env.ORCHESTRATOR_QODER_BIN;
  const prevMode = process.env.FAKE_MODE;
  process.env.ORCHESTRATOR_QODER_BIN = fakeBin;
  process.env.FAKE_MODE = mode;
  return fn().finally(() => {
    if (prevBin === undefined) delete process.env.ORCHESTRATOR_QODER_BIN;
    else process.env.ORCHESTRATOR_QODER_BIN = prevBin;
    if (prevMode === undefined) delete process.env.FAKE_MODE;
    else process.env.FAKE_MODE = prevMode;
  });
}

describe('qoder adapter', () => {
  it('success: parses stream-json events and writes the file', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'orch-qoder-'));
    const events: UnifiedEvent[] = [];
    await withFakeEnv('success', async () => {
      const result = await qoderAdapter.run({
        prompt: 'create hello.ts',
        cwd,
        onEvent: (e) => events.push(e),
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stderr, '');
    });
    assert.ok(existsSync(join(cwd, 'hello.ts')));
    assert.ok(events.some((e) => e.type === 'tool_call'));
  });

  it('fail: non-zero exit + stderr reported explicitly', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'orch-qoder-'));
    await withFakeEnv('fail', async () => {
      const result = await qoderAdapter.run({ prompt: 'x', cwd, onEvent: () => {} });
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /simulated failure/);
    });
  });

  it('abort: SIGTERM kills the child and the run resolves promptly', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'orch-qoder-'));
    await withFakeEnv('slow', async () => {
      const controller = new AbortController();
      const started = Date.now();
      const promise = qoderAdapter.run({
        prompt: 'slow one',
        cwd,
        signal: controller.signal,
        onEvent: () => {},
      });
      setTimeout(() => controller.abort(), 300);
      const result = await promise;
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 1500, `abort took too long: ${elapsed}ms (slow mode is 2000ms)`);
      assert.equal(result.signal, 'SIGTERM');
      assert.equal(result.exitCode, null);
    });
  });
});
