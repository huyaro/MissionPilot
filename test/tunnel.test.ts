// Tunnel manager tests — spawn, health check, restart, stop, spawn failure.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TunnelManager } from '../src/tunnel.js';

const fakeBin = join(process.cwd(), 'scripts', 'fake-tunnel-client.mjs');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForState(
  mgr: TunnelManager,
  want: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (mgr.status().state === want) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for tunnel state ${want} (got ${mgr.status().state})`);
}

describe('tunnel manager', () => {
  it('starts, becomes healthy via /healthz, and stops cleanly', async () => {
    chmodSync(fakeBin, 0o755);
    const dataDir = mkdtempSync(join(tmpdir(), 'orch-tunnel-'));
    const mgr = new TunnelManager({
      bin: fakeBin,
      tunnelId: 'tunnel_test',
      apiKey: 'test-key',
      mcpServerUrl: 'http://127.0.0.1:8788/mcp',
      dataDir,
      healthCheckIntervalMs: 200,
    });
    try {
      mgr.start();
      await waitForState(mgr, 'running');
      const s = mgr.status();
      assert.ok(s.pid !== null);
      assert.ok(s.healthUrl?.includes('/healthz'));
      assert.equal(s.restarts, 0);
    } finally {
      mgr.stop();
    }
    assert.equal(mgr.status().state, 'stopped');
  });

  it('restarts after an unexpected exit and becomes healthy again', async () => {
    chmodSync(fakeBin, 0o755);
    process.env.FAKE_TUNNEL_EXIT_AFTER_MS = '400';
    const dataDir = mkdtempSync(join(tmpdir(), 'orch-tunnel-'));
    const mgr = new TunnelManager({
      bin: fakeBin,
      tunnelId: 'tunnel_test',
      apiKey: 'test-key',
      mcpServerUrl: 'http://127.0.0.1:8788/mcp',
      dataDir,
      healthCheckIntervalMs: 200,
      maxRestarts: 5,
    });
    try {
      mgr.start();
      await waitForState(mgr, 'running');
      // The fake exits after 400ms; the manager must restart it.
      await waitForState(mgr, 'reconnecting', 5_000);
      await waitForState(mgr, 'running', 10_000);
      assert.ok(mgr.status().restarts >= 1);
    } finally {
      delete process.env.FAKE_TUNNEL_EXIT_AFTER_MS;
      mgr.stop();
    }
  });

  it('missing binary fails fast with an explicit error', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orch-tunnel-'));
    const mgr = new TunnelManager({
      bin: '/nonexistent/tunnel-client',
      tunnelId: 'tunnel_test',
      apiKey: 'test-key',
      mcpServerUrl: 'http://127.0.0.1:8788/mcp',
      dataDir,
      healthCheckIntervalMs: 200,
    });
    try {
      mgr.start();
      await waitForState(mgr, 'failed');
      assert.match(mgr.status().lastError ?? '', /failed to spawn/);
    } finally {
      mgr.stop();
    }
  });

  it('refuses to construct without tunnel id or API key', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orch-tunnel-'));
    assert.throws(
      () =>
        new TunnelManager({
          tunnelId: '',
          apiKey: 'k',
          mcpServerUrl: 'http://127.0.0.1:8788/mcp',
          dataDir,
        }),
      /tunnel id/,
    );
    assert.throws(
      () =>
        new TunnelManager({
          tunnelId: 'tunnel_x',
          apiKey: '',
          mcpServerUrl: 'http://127.0.0.1:8788/mcp',
          dataDir,
        }),
      /API key/,
    );
  });
});
