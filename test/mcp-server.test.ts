// End-to-end MCP test: spawn the real server over stdio, speak JSON-RPC,
// dispatch via the fake executor, poll to done. This is the closest VM-side
// approximation of DoD 1 (Codex -> dispatch -> get_attempt); the real Codex
// + real codebuddy run stays a Mac-side check (MILESTONES.md section 8).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTempGitRepo, git } from './helpers.js';

const serverJs = join(process.cwd(), 'dist', 'src', 'server.js');
const fakeBin = join(process.cwd(), 'scripts', 'fake-executor.mjs');

interface RpcResponse {
  jsonrpc: string;
  id?: number;
  result?: { content?: Array<{ text?: string }>; isError?: boolean };
  error?: { message: string };
}

class McpClient {
  private nextId = 1;
  private buf = '';
  private pending = new Map<number, (r: RpcResponse) => void>();
  private stderr = '';
  private proc: ChildProcessWithoutNullStreams;

  constructor(proc: ChildProcessWithoutNullStreams) {
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      this.buf += chunk;
      let idx: number;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        if (line.trim() === '') continue;
        const msg = JSON.parse(line) as RpcResponse;
        if (typeof msg.id === 'number') {
          const resolve = this.pending.get(msg.id);
          if (resolve) {
            this.pending.delete(msg.id);
            resolve(msg);
          }
        }
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
  }

  request(method: string, params: unknown): Promise<RpcResponse> {
    const id = this.nextId++;
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15_000);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method: string, params: unknown): void {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  getStderr(): string {
    return this.stderr;
  }
}

async function callTool(
  client: McpClient,
  name: string,
  args: unknown,
): Promise<{ text: string; isError: boolean }> {
  const res = await client.request('tools/call', { name, arguments: args });
  assert.ok(!res.error, `tools/call ${name} failed at protocol level: ${JSON.stringify(res.error)}`);
  const content = res.result?.content?.[0];
  return { text: content?.text ?? '', isError: res.result?.isError ?? false };
}

describe('MCP server over stdio', () => {
  it('initialize -> tools/list -> dispatch_task -> get_attempt to done', async () => {
    chmodSync(fakeBin, 0o755);
    const dataDir = mkdtempSync(join(tmpdir(), 'orch-mcp-'));
    const repo = await makeTempGitRepo();
    const proc = spawn(process.execPath, [serverJs], {
      env: {
        ...process.env,
        ORCHESTRATOR_DATA_DIR: dataDir,
        ORCHESTRATOR_CODEBUDDY_BIN: fakeBin,
        FAKE_MODE: 'success',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const client = new McpClient(proc);
    try {
      const init = await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mcp-test', version: '0.1.0' },
      });
      assert.ok(init.result, `initialize failed: ${JSON.stringify(init)}`);
      client.notify('notifications/initialized', {});

      const list = await client.request('tools/list', {});
      const tools = (list.result as unknown as { tools: Array<{ name: string }> }).tools;
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

      const dispatch = await callTool(client, 'dispatch_task', {
        agent: 'codebuddy',
        task: { title: 'Create hello', prompt: 'create hello.ts exporting hello()' },
        contract: 'hello.ts exists and exports hello',
        workdir: repo,
      });
      assert.equal(dispatch.isError, false, dispatch.text);
      const { attempt_id } = JSON.parse(dispatch.text) as { attempt_id: string };
      assert.ok(attempt_id.startsWith('att_'));

      // Poll get_attempt until terminal.
      let final: { status: string; diff_summary: { files: string[] } } | null = null;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const got = await callTool(client, 'get_attempt', { attempt_id });
        assert.equal(got.isError, false, got.text);
        const body = JSON.parse(got.text) as {
          status: string;
          diff_summary: { files: string[] };
        };
        if (body.status === 'done' || body.status === 'failed') {
          final = body;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.ok(final, 'attempt never reached a terminal state');
      assert.equal(final.status, 'done');
      assert.ok(final.diff_summary.files.includes('hello.ts'));
      // INV-2: main repo untouched.
      assert.equal(await git(repo, ['status', '--porcelain']), '');
    } finally {
      proc.kill('SIGTERM');
    }
  });

  it('P1 flow over MCP: create_mission -> submit_plan -> get_mission to done', async () => {
    chmodSync(fakeBin, 0o755);
    const dataDir = mkdtempSync(join(tmpdir(), 'orch-mcp-'));
    const repo = await makeTempGitRepo();
    const proc = spawn(process.execPath, [serverJs], {
      env: {
        ...process.env,
        ORCHESTRATOR_DATA_DIR: dataDir,
        ORCHESTRATOR_CODEBUDDY_BIN: fakeBin,
        ORCHESTRATOR_QODER_BIN: fakeBin,
        ORCHESTRATOR_TICK_MS: '500',
        FAKE_MODE: 'success',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const client = new McpClient(proc);
    try {
      await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mcp-test', version: '0.1.0' },
      });
      client.notify('notifications/initialized', {});
      const created = await callTool(client, 'create_mission', { goal: 'two tasks', repo });
      assert.equal(created.isError, false, created.text);
      const { mission_id } = JSON.parse(created.text) as { mission_id: string };
      const planned = await callTool(client, 'submit_plan', {
        mission_id,
        tasks: [
          {
            key: 'a',
            title: 'Task A',
            prompt: 'create hello.ts',
            contract: 'hello.ts exists',
            acceptance: 'hello.ts exports hello',
          },
          {
            key: 'b',
            title: 'Task B',
            prompt: 'extend hello.ts',
            contract: 'hello.ts still exists',
            acceptance: 'hello.ts exports hello',
            depends_on: ['a'],
          },
        ],
      });
      assert.equal(planned.isError, false, planned.text);
      // Poll get_mission until the scheduler finishes the DAG.
      let finalStatus = '';
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const got = await callTool(client, 'get_mission', { mission_id });
        assert.equal(got.isError, false, got.text);
        const body = JSON.parse(got.text) as { status: string };
        finalStatus = body.status;
        if (finalStatus === 'done' || finalStatus === 'failed') break;
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.equal(finalStatus, 'done');
      assert.equal(await git(repo, ['status', '--porcelain']), '');
    } finally {
      proc.kill('SIGTERM');
    }
  });

  it('invalid args and unknown attempt return isError, not a crash', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orch-mcp-'));
    const proc = spawn(process.execPath, [serverJs], {
      env: { ...process.env, ORCHESTRATOR_DATA_DIR: dataDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const client = new McpClient(proc);
    try {
      await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mcp-test', version: '0.1.0' },
      });
      client.notify('notifications/initialized', {});
      const bad = await callTool(client, 'dispatch_task', {
        agent: 'gemini',
        task: { title: 't', prompt: 'p' },
        contract: 'c',
        workdir: '/tmp',
      });
      assert.equal(bad.isError, true);
      assert.match(bad.text, /unknown agent/);
      const missing = await callTool(client, 'get_attempt', { attempt_id: 'att_nope' });
      assert.equal(missing.isError, true);
      assert.match(missing.text, /attempt not found/);
    } finally {
      proc.kill('SIGTERM');
    }
  });
});
