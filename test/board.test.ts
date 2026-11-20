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
  });

  it('rejects /api/* without a token', async () => {
    const res = await fetch(`${base}/api/missions`);
    assert.equal(res.status, 401);
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
    assert.equal((byId.get('codebuddy') as any).state, 'missing'); // VM has no codebuddy binary
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

  it('returns 404 for unknown api routes', async () => {
    const r = await api('/api/nope');
    assert.equal(r.status, 404);
  });
});
