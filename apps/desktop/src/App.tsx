import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BoardApi, probeHealth, type BoardEventMsg } from './api';
import { backendStatus, getAppToken, getEnvToken, isTauri, resolveBackendPath, startBackend } from './tauri';
import { Overview, type NavTarget } from './pages/Overview';
import { MissionDetail } from './pages/MissionDetail';
import { AttemptDetail } from './pages/AttemptDetail';
import { Approvals } from './pages/Approvals';
import { Scoreboard } from './pages/Scoreboard';
import { Ledger } from './pages/Ledger';
import { Connections } from './pages/Connections';
import './styles.css';

const NAV: { id: string; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'approvals', label: 'Approval center' },
  { id: 'scoreboard', label: 'Scoreboard' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'connections', label: 'Connections' },
];

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [backendRunning, setBackendRunning] = useState<boolean | null>(null);
  const [starting, setStarting] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [manualToken, setManualToken] = useState('');
  const [backendJs, setBackendJs] = useState('');
  // Resolved default backend path (undefined = not looked up yet).
  const [defaultBackendJs, setDefaultBackendJs] = useState<string | null | undefined>(undefined);
  // Guard the one-shot auto-start (StrictMode double-invokes effects in dev).
  const autoStartTried = useRef(false);
  const [nav, setNav] = useState<NavTarget>({ page: 'overview' });
  const [events, setEvents] = useState<BoardEventMsg[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [sidebarTick, setSidebarTick] = useState(0);
  const [tunnelState, setTunnelState] = useState<string | null>(null);
  const apiRef = useRef<BoardApi | null>(null);

  const api = useMemo(() => (token ? new BoardApi(token) : null), [token]);
  apiRef.current = api;

  const checkBackend = useCallback(async () => {
    const status = await backendStatus();
    setBackendRunning(status.running);
    if (status.running && !token) {
      const appToken = await getAppToken();
      if (appToken) {
        setToken(appToken);
        return;
      }
      // Backend started externally (e.g. in a terminal): use the token
      // from this process's environment when present.
      const envToken = await getEnvToken();
      if (envToken) setToken(envToken);
      return;
    }
    if (!status.running && isTauri() && !autoStartTried.current) {
      // Normal path: the app starts its own backend and takes the token
      // straight from start_backend — no Setup screen, no pasting.
      // The Setup screen below is only the fallback (auto-start failed,
      // or an externally started backend with no shared token).
      autoStartTried.current = true;
      setStarting(true);
      try {
        setDefaultBackendJs(await resolveBackendPath());
        const newToken = await startBackend(undefined);
        setToken(newToken);
        setBackendRunning(true);
      } catch (e) {
        setSetupError(e instanceof Error ? e.message : String(e));
      } finally {
        setStarting(false);
      }
    }
  }, [token]);

  useEffect(() => {
    void checkBackend();
  }, [checkBackend]);

  // Live events (SSE) + sidebar counters, once we have a token.
  useEffect(() => {
    if (!api) return;
    // Seed the activity feed from the ledger (recent history), then let
    // SSE append live events. The bus is in-memory and does not replay,
    // so without this the panel would sit empty after a restart.
    api
      .ledger()
      .then((r) =>
        setEvents(
          r.entries
            .slice(-12)
            .reverse()
            .map((e) => ({ type: e.type, ts: e.ts, summary: e.detail })),
        ),
      )
      .catch(() => undefined);
    let close: (() => void) | null = null;
    try {
      close = api.subscribeEvents((e) => {
        if (e.summary === 'connected') return;
        setEvents((prev) => [e, ...prev].slice(0, 50));
      });
    } catch {
      // SSE unavailable in this environment; pages still fetch on demand.
    }
    const loadCounts = () => {
      api
        .approvals('pending')
        .then((r) => setPendingCount(r.approvals.length))
        .catch(() => undefined);
      api
        .connections()
        .then((r) => setTunnelState(r.tunnel ? r.tunnel.state : 'disabled'))
        .catch(() => undefined);
    };
    loadCounts();
    const timer = setInterval(loadCounts, 10_000);
    return () => {
      close?.();
      clearInterval(timer);
    };
  }, [api, sidebarTick]);

  const handleStartBackend = async () => {
    setStarting(true);
    setSetupError(null);
    try {
      const newToken = await startBackend(backendJs.trim() || undefined);
      setToken(newToken);
      setBackendRunning(true);
    } catch (e) {
      setSetupError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const handleManualToken = async () => {
    const t = manualToken.trim();
    if (!t) return;
    const ok = await probeHealth();
    if (!ok) {
      setSetupError('Backend is not reachable on 127.0.0.1:8788. Start it first.');
      return;
    }
    setToken(t);
  };

  if (backendRunning === null || (starting && !token)) {
    return <p className="sub" style={{ padding: 32 }}>{starting ? 'Starting backend…' : 'Checking backend…'}</p>;
  }

  if (!backendRunning || !api) {
    return (
      <div className="setup">
        <div className="card">
          <h1>MissionPilot</h1>
          <p className="sub">
            The backend is not running on 127.0.0.1:8788. Start it from the app (the app spawns
            the backend as a managed process), or start it yourself and paste the token.
          </p>
          {setupError && <p className="error">{setupError}</p>}
          <div className="form-row">
            <label>Backend JS (optional)</label>
            <input
              value={backendJs}
              placeholder="path to dist/src/server.js"
              onChange={(e) => setBackendJs(e.target.value)}
              style={{ flex: 1 }}
            />
          </div>
          {defaultBackendJs !== undefined && (
            <p className="sub">
              {defaultBackendJs ? (
                <>Leave blank to use: <span className="mono">{defaultBackendJs}</span></>
              ) : (
                'Backend JS not found — run npm run build first, or paste its path above.'
              )}
            </p>
          )}
          <div className="btn-row">
            <button className="btn" disabled={starting} onClick={() => void handleStartBackend()}>
              {starting ? 'Starting…' : 'Start backend'}
            </button>
          </div>
          <hr style={{ margin: '20px 0', border: 'none', borderTop: '1px solid var(--border)' }} />
          <p className="sub">Or connect to an already-running backend:</p>
          <div className="form-row">
            <label>Bearer token</label>
            <input
              value={manualToken}
              type="password"
              placeholder="ORCHESTRATOR_MCP_TOKEN"
              onChange={(e) => setManualToken(e.target.value)}
              style={{ flex: 1 }}
            />
          </div>
          <div className="btn-row">
            <button className="btn secondary" onClick={() => void handleManualToken()}>
              Connect
            </button>
          </div>
          <p className="sub" style={{ marginTop: 16 }}>
            Manual start:{' '}
            <span className="mono">
              ORCHESTRATOR_TRANSPORT=http ORCHESTRATOR_MCP_TOKEN=&lt;token&gt; node
              dist/src/server.js
            </span>
          </p>
        </div>
      </div>
    );
  }

  const page = nav.page;
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">MissionPilot</div>
        {NAV.map((n) => (
          <button
            key={n.id}
            className={`nav-btn ${page === n.id || (n.id === 'overview' && (page === 'mission' || page === 'attempt')) ? 'active' : ''}`}
            onClick={() => setNav({ page: n.id })}
          >
            <span>{n.label}</span>
            {n.id === 'approvals' && pendingCount > 0 && <span className="badge">{pendingCount}</span>}
          </button>
        ))}
        <div className="sidebar-section">
          <div className="conn-row">
            <span>Backend</span>
            <span className="pill connected">running</span>
          </div>
          <div className="conn-row">
            <span>Tunnel</span>
            <span className={`pill ${tunnelState ?? 'disabled'}`}>{tunnelState ?? '—'}</span>
          </div>
          <div className="conn-row">
            <span>Pending approvals</span>
            <span>{pendingCount}</span>
          </div>
        </div>
      </aside>
      <main className="main">
        {page === 'overview' && (
          <Overview api={api} events={events} onNavigate={setNav} />
        )}
        {page === 'mission' && nav.missionId && (
          <MissionDetail api={api} missionId={nav.missionId} onNavigate={setNav} />
        )}
        {page === 'attempt' && nav.attemptId && <AttemptDetail api={api} attemptId={nav.attemptId} />}
        {page === 'approvals' && <Approvals api={api} onChanged={() => setSidebarTick((t) => t + 1)} />}
        {page === 'scoreboard' && <Scoreboard api={api} />}
        {page === 'ledger' && <Ledger api={api} />}
        {page === 'connections' && <Connections api={api} />}
      </main>
    </div>
  );
}
