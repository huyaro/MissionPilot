// Board API (P3): the local REST + SSE API the Tauri desktop board reads.
// Same bearer token as the MCP endpoint (checked by HttpMcpServer before
// this handler runs). All routes are /api/* on the same 127.0.0.1 port.
// This is NOT a browser-served page — the frontend lives in the Tauri app
// and calls these endpoints; nothing here serves HTML.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import type { Store } from './store.js';
import { computeScoreboard } from './scoreboard.js';
import { verifyLedger } from './ledger.js';
import { decideApproval, executeApprovedPush } from './approvals.js';
import { subscribeBoardEvents, type BoardEvent } from './bus.js';
import type { TunnelStatus } from './tunnel.js';

export interface TunnelTest {
  ok: boolean;
  tunnelHealthy: boolean;
  mcpReachable: boolean;
  message: string;
}

export interface TunnelTestResult {
  status: TunnelStatus;
  test: TunnelTest;
}

export interface BoardDeps {
  store: Store;
  /** Tunnel status when the server manages one; null = tunnel disabled. */
  getTunnelStatus?: () => TunnelStatus | null;
  /**
   * Current tunnel id (env default or UI-configured) and whether an API
   * key is held in memory. The key itself is never exposed.
   */
  getTunnelConfig?: () => { tunnelId: string | null; apiKeySet: boolean };
  /**
   * Apply UI values (stored in memory only) and (re)start tunnel-client.
   * Waits briefly for it to come up healthy, then returns its status.
   */
  startTunnel?: (tunnelId: string, apiKey: string) => Promise<TunnelStatus>;
  /**
   * Stop the tunnel managed by the server, if any. Drops the
   * in-memory API key with it.
   */
  stopTunnel?: () => void;
  /**
   * Test the channel without changing config. Returns null when no
   * tunnel has been started yet.
   */
  testTunnel?: () => Promise<TunnelTestResult | null>;
}

const BODY_LIMIT = 10 * 1024 * 1024;

// Executor connection states, grounded in the 2026-11-19/20 decisions:
// codebuddy + qoder are the P0/P1 executors (binary presence = reachable);
// workbuddy has no CLI and stays 'pending' (pi route is out of scope);
// gemini is 'not-connected' (consumer plan cannot be wrapped, per ToS).
// Read at request time (not module load) so tests can point the probe at
// controlled paths; binary presence is still the reachability signal.
function getExecutors() {
  return [
    { id: 'codebuddy', label: 'CodeBuddy', bin: process.env.ORCHESTRATOR_CODEBUDDY_BIN ?? 'codebuddy' },
    { id: 'qoder', label: 'Qoder', bin: process.env.ORCHESTRATOR_QODER_BIN ?? 'qoder' },
    { id: 'workbuddy', label: 'WorkBuddy', bin: null },
    { id: 'gemini', label: 'Gemini', bin: null },
  ] as const;
}

type ExecutorState = 'connected' | 'pending' | 'not-connected' | 'missing';

const whichCache = new Map<string, { at: number; found: boolean }>();

function whichBin(bin: string): Promise<boolean> {
  const cached = whichCache.get(bin);
  if (cached && Date.now() - cached.at < 60_000) return Promise.resolve(cached.found);
  return new Promise((resolve) => {
    execFile('which', [bin], { timeout: 5_000 }, (err) => {
      const found = !err;
      whichCache.set(bin, { at: Date.now(), found });
      resolve(found);
    });
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  return JSON.parse(text) as unknown;
}

/** Returns true when the request was handled (any /api/* path). */
export function createBoardHandler(deps: BoardDeps) {
  const { store } = deps;
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    if (!path.startsWith('/api/')) return false;
    try {
      // -- missions ----------------------------------------------------------
      if (req.method === 'GET' && path === '/api/missions') {
        const missions = store.listAllMissions().map((m) => {
          const tasks = store.listTasksByMission(m.id);
          return {
            ...m,
            taskCount: tasks.length,
            doneTasks: tasks.filter((t) => t.status === 'done').length,
            failedTasks: tasks.filter((t) => t.status === 'failed').length,
          };
        });
        json(res, 200, { missions });
        return true;
      }
      const missionMatch = /^\/api\/missions\/([^/]+)$/.exec(path);
      if (req.method === 'GET' && missionMatch) {
        const mission = store.getMission(missionMatch[1]);
        if (!mission) {
          json(res, 404, { error: 'mission not found' });
          return true;
        }
        const tasks = store.listTasksByMission(mission.id).map((t) => {
          const attempts = store.listAttemptsByTask(t.id);
          const latest = attempts[attempts.length - 1] ?? null;
          return { ...t, attempts: attempts.length, latestAttempt: latest };
        });
        const proposals = store.listReplanProposals(mission.id);
        const estimated = tasks.reduce((sum, t) => sum + (t.estimate ?? 0), 0);
        json(res, 200, { mission, tasks, proposals, budget: { limit: mission.budget, estimated } });
        return true;
      }
      // -- attempts ----------------------------------------------------------
      const attemptMatch = /^\/api\/attempts\/([^/]+)$/.exec(path);
      if (req.method === 'GET' && attemptMatch) {
        const attempt = store.getAttempt(attemptMatch[1]);
        if (!attempt) {
          json(res, 404, { error: 'attempt not found' });
          return true;
        }
        const events = store.listEvents(attempt.id);
        const worktree = store.getWorktreeByAttempt(attempt.id);
        let evidence: unknown = null;
        if (attempt.evidence) {
          try {
            evidence = JSON.parse(attempt.evidence) as unknown;
          } catch {
            evidence = attempt.evidence;
          }
        }
        json(res, 200, { attempt, events, worktree, evidence });
        return true;
      }
      // -- scoreboard / ledger ----------------------------------------------
      if (req.method === 'GET' && path === '/api/scoreboard') {
        json(res, 200, computeScoreboard(store));
        return true;
      }
      if (req.method === 'GET' && path === '/api/ledger') {
        const missionId = url.searchParams.get('mission_id') ?? undefined;
        const entries = store.listLedgerEntries(missionId);
        json(res, 200, { entries, chain: verifyLedger(store) });
        return true;
      }
      // -- approvals ---------------------------------------------------------
      if (req.method === 'GET' && path === '/api/approvals') {
        const status = url.searchParams.get('status');
        const approvals = store.listApprovals(
          status === 'pending' || status === 'approved' || status === 'rejected'
            ? status
            : undefined,
        );
        json(res, 200, { approvals });
        return true;
      }
      const decisionMatch = /^\/api\/approvals\/([^/]+)\/decision$/.exec(path);
      if (req.method === 'POST' && decisionMatch) {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const decision = body.decision;
        if (decision !== 'approved' && decision !== 'rejected') {
          json(res, 400, { error: "decision must be 'approved' or 'rejected'" });
          return true;
        }
        const reason = typeof body.reason === 'string' ? body.reason : null;
        try {
          const { approval } = decideApproval(store, decisionMatch[1], decision, reason);
          let push: { pushed: boolean; note: string } | undefined;
          if (decision === 'approved' && approval.kind === 'push') {
            push = await executeApprovedPush(store, approval.id);
          }
          json(res, 200, { approval, push });
        } catch (err) {
          json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return true;
      }
      // -- executors ---------------------------------------------------------
      if (req.method === 'GET' && path === '/api/executors') {
        const executors = await Promise.all(
          getExecutors().map(async (e) => {
            let state: ExecutorState;
            if (e.id === 'workbuddy') state = 'pending';
            else if (e.id === 'gemini') state = 'not-connected';
            else state = (await whichBin(e.bin)) ? 'connected' : 'missing';
            const config = store.getExecutorConfig(e.id);
            return { id: e.id, label: e.label, state, config };
          }),
        );
        json(res, 200, { executors });
        return true;
      }
      const configMatch = /^\/api\/executors\/([^/]+)\/config$/.exec(path);
      if (configMatch && (req.method === 'GET' || req.method === 'PUT')) {
        const agent = configMatch[1];
        if (!getExecutors().some((e) => e.id === agent)) {
          json(res, 404, { error: 'unknown executor' });
          return true;
        }
        if (req.method === 'GET') {
          json(res, 200, { config: store.getExecutorConfig(agent) });
          return true;
        }
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const models = body.models;
        if (models !== undefined && (!Array.isArray(models) || !models.every((m) => typeof m === 'string'))) {
          json(res, 400, { error: 'models must be an array of strings' });
          return true;
        }
        const defaultModel = body.defaultModel;
        if (defaultModel !== undefined && defaultModel !== null && typeof defaultModel !== 'string') {
          json(res, 400, { error: 'defaultModel must be a string or null' });
          return true;
        }
        if (
          typeof defaultModel === 'string' &&
          Array.isArray(models) &&
          !models.includes(defaultModel)
        ) {
          json(res, 400, { error: 'defaultModel must be one of models' });
          return true;
        }
        const reasoning = body.reasoning;
        if (
          reasoning !== undefined &&
          reasoning !== null &&
          reasoning !== 'low' &&
          reasoning !== 'medium' &&
          reasoning !== 'high'
        ) {
          json(res, 400, { error: "reasoning must be 'low', 'medium', 'high' or null" });
          return true;
        }
        // Model/reasoning config is recorded for the board; the CLI adapters
        // do not yet pass model flags (flag names are unverified until the
        // Mac pre-flight confirms them — see MILESTONES §8).
        const config = store.upsertExecutorConfig(agent, {
          models: Array.isArray(models) ? (models as string[]) : undefined,
          defaultModel: (defaultModel as string | null | undefined) ?? undefined,
          reasoning: (reasoning as string | null | undefined) ?? undefined,
        });
        json(res, 200, { config });
        return true;
      }
      // -- connections -------------------------------------------------------
      if (req.method === 'GET' && path === '/api/connections') {
        const tunnel = deps.getTunnelStatus ? deps.getTunnelStatus() : null;
        const tunnelConfig = deps.getTunnelConfig
          ? deps.getTunnelConfig()
          : { tunnelId: null as string | null, apiKeySet: false };
        json(res, 200, {
          brains: [
            {
              id: 'codex',
              label: 'Codex',
              transport: 'stdio',
              status: 'available',
              note: '本地 stdio MCP——连接方式：codex mcp add local-agents',
            },
            {
              id: 'chatgpt',
              label: 'ChatGPT',
              transport: 'http + tunnel',
              status: tunnel ? (tunnel.state === 'running' ? 'connected' : 'pending') : 'disabled',
              note: tunnel
                ? `隧道 ${tunnel.tunnelId}（${tunnel.state}）`
                : '未启用。在设置页填写 Tunnel ID 与 API key 并测试连接。完整 MCP（含写操作）需 Business/Enterprise/Edu 套餐；Pro 仅只读。',
            },
          ],
          tunnel,
          tunnelConfig,
          executors: (await Promise.all(
            getExecutors().map(async (e) => {
              let state: ExecutorState;
              if (e.id === 'workbuddy') state = 'pending';
              else if (e.id === 'gemini') state = 'not-connected';
              else state = (await whichBin(e.bin)) ? 'connected' : 'missing';
              return { id: e.id, label: e.label, state };
            }),
          )),
        });
        return true;
      }
      // -- tunnel configuration (Settings UI) -------------------------------
      // The API key is held in memory only: never written to disk, never
      // logged, and never echoed back in any response.
      // Start and test are separate on purpose: starting applies the config
      // and (re)starts tunnel-client; testing only verifies the channel
      // and never starts a tunnel by itself.
      if (req.method === 'POST' && path === '/api/tunnel/config') {
        if (!deps.startTunnel) {
          json(res, 503, { error: '隧道配置不可用（后端未以 HTTP 模式运行）' });
          return true;
        }
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const tunnelId = typeof body.tunnelId === 'string' ? body.tunnelId.trim() : '';
        const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
        // Empty fields fall back to the saved config: the key is never
        // echoed back, so the UI cannot prefill it — an empty key
        // means "use the saved one". The backend resolves it.
        const cfg = deps.getTunnelConfig?.() ?? { tunnelId: null, apiKeySet: false };
        const finalId = tunnelId || cfg.tunnelId || '';
        if (!finalId) {
          json(res, 400, { error: '请填写 Tunnel ID' });
          return true;
        }
        if (!apiKey && !cfg.apiKeySet) {
          json(res, 400, { error: '请填写 API 密钥' });
          return true;
        }
        const tunnel = await deps.startTunnel(finalId, apiKey);
        json(res, 200, { tunnel });
        return true;
      }
      if (req.method === 'POST' && path === '/api/tunnel/test') {
        if (!deps.testTunnel) {
          json(res, 503, { error: '隧道测试不可用（后端未以 HTTP 模式运行）' });
          return true;
        }
        const result = await deps.testTunnel();
        if (!result) {
          json(res, 409, { error: '隧道尚未启动，请先点「启动隧道」' });
          return true;
        }
        json(res, 200, result);
        return true;
      }
      if (req.method === 'POST' && path === '/api/tunnel/stop') {
        if (!deps.stopTunnel) {
          json(res, 503, { error: '隧道停止不可用（后端未以 HTTP 模式运行）' });
          return true;
        }
        deps.stopTunnel();
        json(res, 200, { tunnel: null });
        return true;
      }
      // -- SSE ---------------------------------------------------------------
      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const send = (event: BoardEvent): void => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        send({ type: 'attempt_started', ts: new Date().toISOString(), summary: 'connected' });
        const unsubscribe = subscribeBoardEvents(send);
        const heartbeat = setInterval(() => {
          res.write(': heartbeat\n\n');
        }, 15_000);
        req.on('close', () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
        return true;
      }
      json(res, 404, { error: 'unknown api route' });
      return true;
    } catch (err) {
      if (!res.headersSent) {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
  };
}
