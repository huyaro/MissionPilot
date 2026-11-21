// Server entry smoke test: --http mode + tunnel manager wiring.
// Spawns the real entry point, waits for the listening + tunnel-healthy
// log lines, then hits /health. (The in-process HttpMcpServer tests in
// http.test.ts cover the protocol itself.)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const serverJs = join(process.cwd(), 'dist', 'src', 'server.js');
const fakeTunnelBin = join(process.cwd(), 'scripts', 'fake-tunnel-client.mjs');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('server entry (--http + tunnel)', () => {
  it('starts HTTP mode and the tunnel becomes healthy', async () => {
    chmodSync(fakeTunnelBin, 0o755);
    const dataDir = mkdtempSync(join(tmpdir(), 'orch-entry-'));
    const proc = spawn(process.execPath, [serverJs, '--http'], {
      env: {
        ...process.env,
        ORCHESTRATOR_DATA_DIR: dataDir,
        ORCHESTRATOR_MCP_TOKEN: 'entry-test-token',
        ORCHESTRATOR_HTTP_PORT: '0',
        ORCHESTRATOR_TICK_MS: '60000',
        ORCHESTRATOR_TUNNEL_BIN: fakeTunnelBin,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    try {
      // Wait for the listening log line and extract the real port.
      let port = 0;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const m = /"msg":"HTTP MCP server listening","host":"[^"]+","port":(\d+)/.exec(stderr);
        if (m) {
          port = Number(m[1]);
          break;
        }
        await sleep(200);
      }
      assert.ok(port > 0, `server did not start listening; stderr:\n${stderr}`);
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(health.status, 200);
      const body = (await health.json()) as { ok: boolean; mode: string };
      assert.equal(body.ok, true);
      assert.equal(body.mode, 'full');
      // Tunnel config comes only from the Settings UI path now (no env
      // config): apply it over HTTP and confirm the tunnel comes up.
      const configRes = await fetch(`http://127.0.0.1:${port}/api/tunnel/config`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer entry-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tunnelId: 'tunnel_test', apiKey: 'test-key' }),
      });
      assert.equal(configRes.status, 200);
      const configBody = (await configRes.json()) as {
        tunnel: { tunnelId: string; state: string };
      };
      assert.equal(configBody.tunnel.tunnelId, 'tunnel_test');
      // Tunnel manager: wait for the healthy log line.
      const healthyDeadline = Date.now() + 15_000;
      let healthy = false;
      while (Date.now() < healthyDeadline) {
        if (stderr.includes('tunnel-client healthy')) {
          healthy = true;
          break;
        }
        await sleep(200);
      }
      assert.equal(healthy, true, `tunnel never became healthy; stderr:\n${stderr}`);
    } finally {
      proc.kill('SIGTERM');
    }
  });
});
