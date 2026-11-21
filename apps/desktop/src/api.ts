// API client for the local board backend (P3).
// The backend runs on 127.0.0.1:8788 (HTTP mode, bearer token). The token
// comes from the Tauri app (it spawned the backend) or from the setup
// screen when the backend was started externally.
// SSE (EventSource) cannot send an Authorization header, so /api/events
// also accepts the token as a ?token= query parameter — localhost only,
// and the backend never logs request URLs.
export const API_BASE = 'http://127.0.0.1:8788';

export interface MissionSummary {
  id: string;
  goal: string;
  constraints: string | null;
  repo: string;
  budget: number | null;
  status: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  taskCount: number;
  doneTasks: number;
  failedTasks: number;
}

export interface TaskDetail {
  id: string;
  missionId: string;
  key: string;
  title: string;
  prompt: string;
  contract: string;
  acceptance: string;
  dependsOn: string[];
  estimate: number | null;
  mode: string | null;
  type: string | null;
  revisionsUsed: number;
  rerouted: boolean;
  status: string;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  latestAttempt: AttemptSummary | null;
}

export interface AttemptSummary {
  id: string;
  taskId: string;
  agent: string;
  worktreePath: string | null;
  status: string;
  exitCode: number | null;
  stderr: string | null;
  diffSummary: string | null;
  evidence: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttemptEvent {
  id: string;
  attemptId: string;
  seq: number;
  type: string;
  payload: string;
  ts: string;
}

export interface Approval {
  id: string;
  kind: 'replan' | 'push';
  missionId: string;
  taskId: string | null;
  summary: string;
  status: 'pending' | 'approved' | 'rejected';
  reason: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface AgentScore {
  agent: string;
  attempts: number;
  passed: number;
  failed: number;
  successRate: number | null;
  avgAttemptsPerTask: number | null;
  elo: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface LedgerEntry {
  seq: number;
  ts: string;
  type: string;
  refId: string | null;
  missionId: string | null;
  detail: string;
  prevHash: string;
  hash: string;
}

export interface ConfigModel {
  id: string;
  reasoning: 'low' | 'medium' | 'high';
  context: string;
}

export interface ExecutorInfo {
  id: string;
  label: string;
  state: 'connected' | 'pending' | 'not-connected' | 'missing';
  /** Binary or config path found (Magpie-style detection). */
  detected: boolean;
  /** What proved the install: the binary path, or the config path. */
  signal: { kind: 'binary' | 'config'; value: string } | null;
  /** Why not detected — names the bins and paths that were checked. */
  reason: string;
  /** Version from `<bin> --version`, when a binary was found and answered. */
  version: string | null;
  /** Whether dispatch is wired for this agent (has a CLI adapter). */
  dispatchable: boolean;
  /** A config row exists in executor_config (i.e. the user configured it). */
  added: boolean;
  config: {
    agent: string;
    /** The models array IS the enabled set (dispatch only uses these). */
    models: ConfigModel[];
    defaultModel: string | null;
    /** False = never dispatched to (config preserved). Rows predating the flag read as enabled. */
    enabled: boolean;
    updatedAt: string;
  } | null;
}

export interface BoardEventMsg {
  type: string;
  ts: string;
  missionId?: string;
  taskId?: string;
  attemptId?: string;
  approvalId?: string;
  summary: string;
}

export interface TunnelInfo {
  state: string;
  tunnelId: string;
  healthUrl: string | null;
  pid: number | null;
  restarts: number;
  lastError: string | null;
}

export class BoardApi {
  constructor(
    private token: string,
    private base: string = API_BASE,
  ) {}

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `request failed: ${res.status}`);
    }
    return (await res.json()) as T;
  }

  listMissions(): Promise<{ missions: MissionSummary[] }> {
    return this.req('/api/missions');
  }

  missionDetail(id: string): Promise<{
    mission: MissionSummary;
    tasks: TaskDetail[];
    proposals: { id: string; taskId: string; reason: string; createdAt: string }[];
    budget: { limit: number | null; estimated: number };
  }> {
    return this.req(`/api/missions/${id}`);
  }

  attemptDetail(id: string): Promise<{
    attempt: AttemptSummary;
    events: AttemptEvent[];
    worktree: { path: string; baseCommit: string; status: string; mergedCommit: string | null } | null;
    evidence: unknown;
  }> {
    return this.req(`/api/attempts/${id}`);
  }

  scoreboard(): Promise<{ agents: AgentScore[]; generatedAt: string }> {
    return this.req('/api/scoreboard');
  }

  ledger(missionId?: string): Promise<{ entries: LedgerEntry[]; chain: { ok: boolean; badSeq?: number } }> {
    return this.req(`/api/ledger${missionId ? `?mission_id=${encodeURIComponent(missionId)}` : ''}`);
  }

  approvals(status?: string): Promise<{ approvals: Approval[] }> {
    return this.req(`/api/approvals${status ? `?status=${status}` : ''}`);
  }

  async decideApproval(
    id: string,
    decision: 'approved' | 'rejected',
    reason?: string,
  ): Promise<{ approval: Approval; push?: { pushed: boolean; note: string } }> {
    return this.req(`/api/approvals/${id}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision, reason: reason ?? null }),
    });
  }

  executors(refresh = false): Promise<{ executors: ExecutorInfo[] }> {
    return this.req(`/api/executors${refresh ? '?refresh=1' : ''}`);
  }

  connections(): Promise<{
    brains: { id: string; label: string; transport: string; status: string; note: string }[];
    tunnel: TunnelInfo | null;
    tunnelConfig: { tunnelId: string | null; apiKeySet: boolean };
    executors: { id: string; label: string; state: string }[];
  }> {
    return this.req('/api/connections');
  }

  /** Apply tunnel ID + API key (memory only) and (re)start tunnel-client. */
  startTunnel(tunnelId: string, apiKey: string): Promise<{ tunnel: TunnelInfo }> {
    return this.req('/api/tunnel/config', {
      method: 'POST',
      body: JSON.stringify({ tunnelId, apiKey }),
    });
  }

  /** Stop the tunnel managed by the backend, if any. */
  stopTunnel(): Promise<{ tunnel: TunnelInfo | null }> {
    return this.req('/api/tunnel/stop', { method: 'POST' });
  }

  async saveExecutorConfig(
    agent: string,
    config: { models?: ConfigModel[]; defaultModel?: string | null; enabled?: boolean },
  ): Promise<{ config: NonNullable<ExecutorInfo['config']> }> {
    return this.req(`/api/executors/${agent}/config`, {
      method: 'PUT',
      body: JSON.stringify(config),
    });
  }

  /** Fetch the model list for one executor, from that agent's own mechanism. */
  executorModels(agent: string): Promise<{ models: string[]; source: string }> {
    return this.req(`/api/executors/${agent}/models`);
  }

  /** Remove an executor's saved config (Settings "remove"). */
  async removeExecutorConfig(agent: string): Promise<{ removed: boolean; config: null }> {
    return this.req(`/api/executors/${agent}/config`, { method: 'DELETE' });
  }

  /** SSE stream; onEvent fires for every board event. Returns a close fn. */
  subscribeEvents(onEvent: (e: BoardEventMsg) => void): () => void {
    const es = new EventSource(
      `${this.base}/api/events?token=${encodeURIComponent(this.token)}`,
    );
    es.onmessage = (msg) => {
      try {
        onEvent(JSON.parse(msg.data) as BoardEventMsg);
      } catch {
        // Ignore malformed SSE frames.
      }
    };
    return () => es.close();
  }
}

/** Probe the backend without a token (health is unauthenticated). */
export async function probeHealth(base: string = API_BASE): Promise<boolean> {
  try {
    const res = await fetch(`${base}/health`);
    return res.ok;
  } catch {
    return false;
  }
}
