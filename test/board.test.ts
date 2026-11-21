// Board API: REST routes, auth, approvals, executor config, SSE.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Dispatcher } from '../src/dispatcher.js';
import { HttpMcpServer } from '../src/http.js';
import { createBoardHandler } from '../src/board.js';
import { createReplanApproval } from '../src/approvals.js';

const TOKEN = 'board-test-token';
let store: Store;
let http: HttpMcpServer;
let base: string;
let prevCodebuddyBin: string | undefined;
let prevQoderBin: string | undefined;

async function api(path: string, opts: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    ...opts,
    headers: { authorization: `Bearer ${TOKEN}`, ...(opts.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

describe('board API', () => {
  before(async () => {
    // Point the executor probe at nonexistent binaries so the state
    // assertions hold on any machine, even one with the CLIs installed.
    prevCodebuddyBin = process.env.ORCHESTRATOR_CODEBUDDY_BIN;
    prevQoderBin = process.env.ORCHESTRATOR_QODER_BIN;
    process.env.ORCHESTRATOR_CODEBUDDY_BIN = '/nonexistent/codebuddy';
    process.env.ORCHESTRATOR_QODER_BIN = '/nonexistent/qoder';
    const dataDir = mkdtempSync(join(tmpdir(), 'orch-board-'));
    store = new Store(join(dataDir, 'db.sqlite'));
    const dispatcher = new Dispatcher(store, new Map(), dataDir);
    const board = createBoardHandler({
      store,
      getTunnelStatus: () => ({
        state: 'running',
        tunnelId: 'tunnel_test',
        healthUrl: 'http://127.0.0.1:1/healthz',
        pid: 123,
        restarts: 0,
        lastError: null,
      }),
    });
    http = new HttpMcpServer(store, dispatcher, { port: 0, token: TOKEN, board });
    const port = await http.listen();
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await http.close();
    store.close();
    if (prevCodebuddyBin === undefined) delete process.env.ORCHESTRATOR_CODEBUDDY_BIN;
    else process.env.ORCHESTRATOR_CODEBUDDY_BIN = prevCodebuddyBin;
    if (prevQoderBin === undefined) delete process.env.ORCHESTRATOR_QODER_BIN;
    else process.env.ORCHESTRATOR_QODER_BIN = prevQoderBin;
  });

  it('rejects /api/* without a token', async () => {
    const res = await fetch(`${base}/api/missions`);
    assert.equal(res.status, 401);
  });

  it('answers CORS preflights and labels API responses (Tauri webview origin)', async () => {
    const pre = await fetch(`${base}/api/missions`, { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    const res = await fetch(`${base}/api/missions`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  it('lists missions and mission detail with budget summary', async () => {
    const m = store.createMission({ goal: 'board test', repo: '/tmp/repo', budget: 10, source: 'codex' });
    store.createTask({ missionId: m.id, key: 't1', title: 'one', contract: 'c', estimate: 4 });
    const list = await api('/api/missions');
    assert.equal(list.status, 200);
    assert.equal(list.body.missions.length, 1);
    assert.equal(list.body.missions[0].taskCount, 1);
    const detail = await api(`/api/missions/${m.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.budget.limit, 10);
    assert.equal(detail.body.budget.estimated, 4);
    assert.equal(detail.body.tasks.length, 1);
    const missing = await api('/api/missions/m_nope');
    assert.equal(missing.status, 404);
  });

  it('serves scoreboard, ledger and connections', async () => {
    const score = await api('/api/scoreboard');
    assert.equal(score.status, 200);
    assert.ok(Array.isArray(score.body.agents));
    const ledger = await api('/api/ledger');
    assert.equal(ledger.status, 200);
    assert.equal(ledger.body.chain.ok, true);
    const conn = await api('/api/connections');
    assert.equal(conn.status, 200);
    assert.equal(conn.body.tunnel.state, 'running');
    assert.equal(
      conn.body.brains.find((b: any) => b.id === 'chatgpt').status,
      'connected',
    );
  });

  it('serves executor states and validates config writes', async () => {
    const execs = await api('/api/executors');
    assert.equal(execs.status, 200);
    const byId = new Map(execs.body.executors.map((e: any) => [e.id, e]));
    assert.equal((byId.get('codebuddy') as any).state, 'missing'); // probe pointed at a nonexistent binary in before()
    assert.equal((byId.get('workbuddy') as any).state, 'pending');
    assert.equal((byId.get('gemini') as any).state, 'not-connected');

    const bad = await api('/api/executors/codebuddy/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ models: 'not-an-array' }),
    });
    assert.equal(bad.status, 400);
    const badDefault = await api('/api/executors/codebuddy/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ models: ['a'], defaultModel: 'b' }),
    });
    assert.equal(badDefault.status, 400);
    const ok = await api('/api/executors/codebuddy/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ models: ['model-a', 'model-b'], defaultModel: 'model-a', reasoning: 'high' }),
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.config.defaultModel, 'model-a');
    assert.equal(ok.body.config.reasoning, 'high');
  });

  it('runs the approval decision flow', async () => {
    const m = store.createMission({ goal: 'approval test', repo: '/tmp/repo', source: 'codex' });
    const t = store.createTask({ missionId: m.id, key: 't1', title: 'one', contract: 'c' });
    const ap = createReplanApproval(store, m.id, t.id, 'both agents failed');
    const list = await api('/api/approvals?status=pending');
    assert.equal(list.status, 200);
    assert.ok(list.body.approvals.some((a: any) => a.id === ap.id));

    const noReason = await api(`/api/approvals/${ap.id}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'rejected' }),
    });
    assert.equal(noReason.status, 400);
    const decided = await api(`/api/approvals/${ap.id}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'rejected', reason: 'retry instead' }),
    });
    assert.equal(decided.status, 200);
    assert.equal(decided.body.approval.status, 'rejected');
  });

  it('streams a hello event over SSE', async () => {
    const res = await fetch(`${base}/api/events`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = res.body?.getReader();
    assert.ok(reader);
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.match(text, /connected/);
    await reader.cancel();
  });

  it('SSE accepts the token as a query param (EventSource cannot send headers)', async () => {
    const res = await fetch(`${base}/api/events?token=${TOKEN}`);
    assert.equal(res.status, 200);
    await res.body?.cancel();
    const bad = await fetch(`${base}/api/events?token=wrong`);
    assert.equal(bad.status, 401);
    await bad.body?.cancel();
  });

  it('returns 404 for unknown api routes', async () => {
    const r = await api('/api/nope');
    assert.equal(r.status, 404);
  });
});

describe('tunnel config API', () => {
  let store2: Store;
  let http2: HttpMcpServer;
  let base2: string;
  let started: { tunnelId: string; apiKey: string } | null;
  let tunnelPresent = true;

  async function api2(path: string, opts: RequestInit = {}): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base2}${path}`, {
      ...opts,
      headers: { authorization: `Bearer ${TOKEN}`, ...(opts.headers ?? {}) },
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  before(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orch-board-tunnel-'));
    store2 = new Store(join(dataDir, 'db.sqlite'));
    const dispatcher = new Dispatcher(store2, new Map(), dataDir);
    started = null;
    const board = createBoardHandler({
      store: store2,
      getTunnelStatus: () => null,
      getTunnelConfig: () => ({ tunnelId: 'tunnel_env', apiKeySet: false }),
      startTunnel: async (tunnelId, apiKey) => {
        started = { tunnelId, apiKey };
        return {
          state: 'running',
          tunnelId,
          pid: 7,
          restarts: 0,
          healthUrl: 'http://127.0.0.1:9/healthz',
          lastError: null,
        };
      },
      testTunnel: async () => {
        if (!tunnelPresent) return null;
        return {
          status: {
            state: 'running',
            tunnelId: 'tunnel_x',
            pid: 7,
            restarts: 0,
            healthUrl: 'http://127.0.0.1:9/healthz',
            lastError: null,
          },
          test: { ok: true, tunnelHealthy: true, mcpReachable: true, message: '通道已接通' },
        };
      },
    });
    http2 = new HttpMcpServer(store2, dispatcher, { port: 0, token: TOKEN, board });
    const port = await http2.listen();
    base2 = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await http2.close();
    store2.close();
  });

  it('exposes the env tunnel id and key-set flag on connections', async () => {
    const conn = await api2('/api/connections');
    assert.equal(conn.status, 200);
    assert.equal(conn.body.tunnelConfig.tunnelId, 'tunnel_env');
    assert.equal(conn.body.tunnelConfig.apiKeySet, false);
  });

  it('rejects tunnel config without both fields', async () => {
    const r = await api2('/api/tunnel/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tunnelId: 'tunnel_x' }),
    });
    assert.equal(r.status, 400);
    assert.equal(started, null);
  });

  it('starts the tunnel and never echoes the API key', async () => {
    const r = await api2('/api/tunnel/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tunnelId: 'tunnel_x', apiKey: 'secret-key-123' }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.tunnel.tunnelId, 'tunnel_x');
    assert.equal(r.body.tunnel.state, 'running');
    assert.equal(started?.tunnelId, 'tunnel_x');
    assert.equal(started?.apiKey, 'secret-key-123');
    assert.ok(!JSON.stringify(r.body).includes('secret-key-123'));
  });

  it('tests the channel without changing config', async () => {
    const before = started;
    const r = await api2('/api/tunnel/test', { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(r.body.test.ok, true);
    assert.equal(r.body.test.tunnelHealthy, true);
    assert.equal(r.body.test.mcpReachable, true);
    assert.equal(started, before);
  });

  it('test reports 409 when no tunnel has been started', async () => {
    tunnelPresent = false;
    try {
      const r = await api2('/api/tunnel/test', { method: 'POST' });
      assert.equal(r.status, 409);
      assert.match(r.body.error, /启动隧道/);
    } finally {
      tunnelPresent = true;
    }
  });

  it('returns 503 when the server cannot configure or test a tunnel', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orch-board-tunnel503-'));
    const s = new Store(join(dataDir, 'db.sqlite'));
    const d = new Dispatcher(s, new Map(), dataDir);
    const board = createBoardHandler({ store: s });
    const h = new HttpMcpServer(s, d, { port: 0, token: TOKEN, board });
    try {
      const port = await h.listen();
      const res = await fetch(`http://127.0.0.1:${port}/api/tunnel/config`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tunnelId: 'tunnel_x', apiKey: 'k' }),
      });
      assert.equal(res.status, 503);
      const test = await fetch(`http://127.0.0.1:${port}/api/tunnel/test`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      });
      assert.equal(test.status, 503);
    } finally {
      await h.close();
      s.close();
    }
  });
});
