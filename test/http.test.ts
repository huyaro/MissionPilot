// Streamable HTTP MCP tests — auth, sessions, tools over HTTP, read-only mode.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Dispatcher } from '../src/dispatcher.js';
import { HttpMcpServer } from '../src/http.js';
import { codebuddyAdapter } from '../src/adapters/codebuddy.js';
import { qoderAdapter } from '../src/adapters/qoder.js';
import { makeTempGitRepo, tempDbPath } from './helpers.js';

const fakeBin = join(process.cwd(), 'scripts', 'fake-executor.mjs');
const TOKEN = 'test-token-123';

interface Started {
  server: HttpMcpServer;
  base: string;
}

async function startServer(readOnly: boolean): Promise<Started> {
  chmodSync(fakeBin, 0o755);
  process.env.ORCHESTRATOR_CODEBUDDY_BIN = fakeBin;
  process.env.ORCHESTRATOR_QODER_BIN = fakeBin;
  process.env.FAKE_MODE = 'success';
  const dataDir = mkdtempSync(join(tmpdir(), 'orch-http-'));
  const store = new Store(tempDbPath());
  const dispatcher = new Dispatcher(
    store,
    new Map([
      ['codebuddy', codebuddyAdapter],
      ['qoder', qoderAdapter],
    ]),
    dataDir,
    { finalizeTasks: false },
  );
  const server = new HttpMcpServer(store, dispatcher, { port: 0, token: TOKEN, readOnly });
  const port = await server.listen();
  return { server, base: `http://127.0.0.1:${port}` };
}

interface RpcResult {
  status: number;
  sessionId: string | null;
  body: unknown;
}

async function rpc(
  base: string,
  sessionId: string | null,
  method: string,
  params: unknown,
  token: string | null = TOKEN,
): Promise<RpcResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = text;
  }
  return { status: res.status, sessionId: res.headers.get('mcp-session-id'), body };
}

async function callTool(
  base: string,
  sessionId: string,
  name: string,
  args: unknown,
): Promise<{ text: string; isError: boolean }> {
  const r = await rpc(base, sessionId, 'tools/call', { name, arguments: args });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const result = r.body as { result?: { content?: Array<{ text?: string }>; isError?: boolean } };
  return { text: result.result?.content?.[0]?.text ?? '', isError: result.result?.isError ?? false };
}

async function initSession(base: string): Promise<string> {
  const r = await rpc(base, null, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'http-test', version: '0.1.0' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.sessionId, 'initialize must return an mcp-session-id');
  return r.sessionId;
}

describe('HTTP MCP transport', () => {
  it('serves tools over HTTP: initialize -> list -> dispatch -> get_attempt', async () => {
    const { server, base } = await startServer(false);
    const repo = await makeTempGitRepo();
    try {
      const sessionId = await initSession(base);
      const list = await rpc(base, sessionId, 'tools/list', {});
      assert.equal(list.status, 200);
      const tools = (list.body as { result: { tools: Array<{ name: string }> } }).result.tools;
      assert.deepEqual(
        tools.map((t) => t.name).sort(),
        [
          'create_mission',
          'dispatch_task',
          'get_attempt',
          'get_mission',
          'read_file',
          'repo_map',
          'search_code',
          'submit_plan',
        ],
      );
      const dispatch = await callTool(base, sessionId, 'dispatch_task', {
        agent: 'codebuddy',
        task: { title: 'Create hello', prompt: 'create hello.ts' },
        contract: 'hello.ts exists',
        workdir: repo,
      });
      assert.equal(dispatch.isError, false, dispatch.text);
      const { attempt_id } = JSON.parse(dispatch.text) as { attempt_id: string };
      let status = '';
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const got = await callTool(base, sessionId, 'get_attempt', { attempt_id });
        const body = JSON.parse(got.text) as { status: string };
        status = body.status;
        if (status === 'done' || status === 'failed') break;
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.equal(status, 'done');
    } finally {
      await server.close();
    }
  });

  it('rejects missing/wrong bearer token with 401', async () => {
    const { server, base } = await startServer(false);
    try {
      const noToken = await rpc(base, null, 'initialize', {}, null);
      assert.equal(noToken.status, 401);
      const wrong = await rpc(base, null, 'initialize', {}, 'wrong-token');
      assert.equal(wrong.status, 401);
      const health = await fetch(`${base}/health`);
      assert.equal(health.status, 200);
      const healthBody = (await health.json()) as { ok: boolean; mode: string };
      assert.equal(healthBody.ok, true);
      assert.equal(healthBody.mode, 'full');
    } finally {
      await server.close();
    }
  });

  it('rejects non-initialize requests without a session', async () => {
    const { server, base } = await startServer(false);
    try {
      const r = await rpc(base, null, 'tools/list', {});
      assert.equal(r.status, 400);
    } finally {
      await server.close();
    }
  });

  it('read-only mode: writes rejected with a reason, reads work', async () => {
    const { server, base } = await startServer(true);
    const repo = await makeTempGitRepo();
    try {
      const sessionId = await initSession(base);
      const dispatch = await callTool(base, sessionId, 'dispatch_task', {
        agent: 'codebuddy',
        task: { title: 't', prompt: 'p' },
        contract: 'c',
        workdir: repo,
      });
      assert.equal(dispatch.isError, true);
      assert.match(dispatch.text, /read-only mode \(P2a\)/);
      const created = await callTool(base, sessionId, 'create_mission', { goal: 'g', repo });
      assert.equal(created.isError, true);
      const tree = await callTool(base, sessionId, 'repo_map', { repo });
      assert.equal(tree.isError, false);
      assert.match(tree.text, /README\.md/);
      const health = (await (await fetch(`${base}/health`)).json()) as { mode: string };
      assert.equal(health.mode, 'readonly');
    } finally {
      await server.close();
    }
  });

  it('refuses to start without a token', () => {
    const store = new Store(tempDbPath());
    try {
      const dispatcher = new Dispatcher(store, new Map(), mkdtempSync(join(tmpdir(), 'orch-http-')));
      assert.throws(
        () => new HttpMcpServer(store, dispatcher, { port: 0, token: '' }),
        /ORCHESTRATOR_MCP_TOKEN/,
      );
    } finally {
      store.close();
    }
  });
});
