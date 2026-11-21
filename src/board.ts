// Board API (P3): the local REST + SSE API the Tauri desktop board reads.
// Same bearer token as the MCP endpoint (checked by HttpMcpServer before
// this handler runs). All routes are /api/* on the same 127.0.0.1 port.
// This is NOT a browser-served page — the frontend lives in the Tauri app
// and calls these endpoints; nothing here serves HTML.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConfigModel, Store } from './store.js';
import { computeScoreboard } from './scoreboard.js';
import { verifyLedger } from './ledger.js';
import { decideApproval, executeApprovedPush } from './approvals.js';
import { subscribeBoardEvents, type BoardEvent } from './bus.js';
import type { TunnelStatus } from './tunnel.js';
import {
  CONTEXT_OPTIONS,
  isKnownExecutor,
  listExecutorModels,
  listExecutors,
} from './executors.js';

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
        const executors = await listExecutors(store, {
          refresh: url.searchParams.get('refresh') === '1',
        });
        json(res, 200, { executors });
        return true;
      }
      // Model list for one executor, fetched from that agent's own
      // mechanism (see src/executors.ts). 502 when the fetch fails —
      // the error message says why, so the UI can show it as-is.
      const modelsMatch = /^\/api\/executors\/([^/]+)\/models$/.exec(path);
      if (req.method === 'GET' && modelsMatch) {
        const agent = modelsMatch[1] as string;
        if (!isKnownExecutor(agent)) {
          json(res, 404, { error: 'unknown executor' });
          return true;
        }
        try {
          const result = await listExecutorModels(agent);
          json(res, 200, result);
        } catch (err) {
          json(res, 502, { error: err instanceof Error ? err.message : String(err) });
        }
        return true;
      }
      const configMatch = /^\/api\/executors\/([^/]+)\/config$/.exec(path);
      if (configMatch && req.method === 'DELETE') {
        const agent = configMatch[1] as string;
        if (!isKnownExecutor(agent)) {
          json(res, 404, { error: 'unknown executor' });
          return true;
        }
        const removed = store.deleteExecutorConfig(agent);
        json(res, 200, { removed, config: null });
        return true;
      }
      if (configMatch && (req.method === 'GET' || req.method === 'PUT')) {
        const agent = configMatch[1] as string;
        if (!isKnownExecutor(agent)) {
          json(res, 404, { error: 'unknown executor' });
          return true;
        }
        if (req.method === 'GET') {
          json(res, 200, { config: store.getExecutorConfig(agent) });
          return true;
        }
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const models = body.models;
        let parsedModels: ConfigModel[] | undefined;
        if (models !== undefined) {
          if (!Array.isArray(models)) {
            json(res, 400, { error: 'models must be an array of {id, reasoning, context}' });
            return true;
          }
          const seen = new Set<string>();
          parsedModels = [];
          for (const entry of models) {
            if (typeof entry !== 'object' || entry === null) {
              json(res, 400, { error: 'each model must be an object {id, reasoning, context}' });
              return true;
            }
            const rec = entry as Record<string, unknown>;
            const id = rec.id;
            const reasoning = rec.reasoning;
            const context = rec.context;
            if (typeof id !== 'string' || id.trim() === '') {
              json(res, 400, { error: 'each model needs a non-empty string id' });
              return true;
            }
            if (reasoning !== 'low' && reasoning !== 'medium' && reasoning !== 'high') {
              json(res, 400, { error: "each model reasoning must be 'low', 'medium' or 'high'" });
              return true;
            }
            if (typeof context !== 'string' || !(CONTEXT_OPTIONS as readonly string[]).includes(context)) {
              json(res, 400, {
                error: `each model context must be one of ${CONTEXT_OPTIONS.join(', ')}`,
              });
              return true;
            }
            if (seen.has(id)) {
              json(res, 400, { error: `duplicate model id: ${id}` });
              return true;
            }
            seen.add(id);
            parsedModels.push({ id, reasoning, context });
          }
        }
        const defaultModel = body.defaultModel;
        if (defaultModel !== undefined && defaultModel !== null && typeof defaultModel !== 'string') {
          json(res, 400, { error: 'defaultModel must be a string or null' });
          return true;
        }
        if (
          typeof defaultModel === 'string' &&
          parsedModels !== undefined &&
          !parsedModels.some((m) => m.id === defaultModel)
        ) {
          json(res, 400, { error: 'defaultModel must be one of models' });
          return true;
        }
        // The models array IS the enabled set: dispatch only ever uses a
        // model from it (see dispatcher.resolveDispatchModel). The CLI
        // adapters receive the chosen model via verified flags only
        // (qoder: --model/--reasoning-effort/--context-window;
        // codebuddy: --model).
        const config = store.upsertExecutorConfig(agent, {
          models: parsedModels,
          defaultModel: (defaultModel as string | null | undefined) ?? undefined,
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
          executors: (await listExecutors(store)).map(({ id, label, state }) => ({ id, label, state })),
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
