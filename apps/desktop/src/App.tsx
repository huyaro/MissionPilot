import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BoardApi, probeHealth, type BoardEventMsg } from './api';
import { backendStatus, getAppToken, getEnvToken, isTauri, resolveBackendPath, startBackend } from './tauri';
import { Overview, type NavTarget } from './pages/Overview';
import { MissionDetail } from './pages/MissionDetail';
import { AttemptDetail } from './pages/AttemptDetail';
import { Approvals } from './pages/Approvals';
import { ScoreboardLedger } from './pages/ScoreboardLedger';
import { Connections } from './pages/Connections';
import { statusLabel } from './labels';
import brandIcon from './assets/icon.png';
import './styles.css';

// Inline SVG icons (stroke, currentColor) — no icon dependency; the
// desktop renderer is native ESM with no bundler.
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const NAV: { id: string; label: string; icon: ReactNode }[] = [
  {
    id: 'overview', label: '总览',
    icon: <Icon><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></Icon>,
  },
  {
    id: 'approvals', label: '审批中心',
    icon: <Icon><circle cx="12" cy="12" r="9" /><path d="m8.5 12.5 2.5 2.5 5-5.5" /></Icon>,
  },
  {
    id: 'scoreboard', label: '记账本',
    icon: <Icon><path d="M4 20V10" /><path d="M10 20V4" /><path d="M16 20v-7" /><path d="M2 20h20" /></Icon>,
  },
  {
    id: 'connections', label: '设置',
    icon: <Icon><line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" /></Icon>,
  },
];

// localStorage access can throw in a restricted webview; preferences then
// just don't persist.
function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore: preference is session-only in this case.
  }
}

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
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    readStored('mission-pilot:theme') === 'dark' ? 'dark' : 'light',
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    readStored('mission-pilot:sidebar-collapsed') === '1',
  );
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

  // Theme + sidebar collapse are persisted across restarts.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    writeStored('mission-pilot:theme', theme);
  }, [theme]);

  useEffect(() => {
    writeStored('mission-pilot:sidebar-collapsed', sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

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
      setSetupError('后端在 127.0.0.1:8788 上不可达，请先启动后端。');
      return;
    }
    setToken(t);
  };

  if (backendRunning === null || (starting && !token)) {
    return <p className="sub" style={{ padding: 32 }}>{starting ? '正在启动后端…' : '正在检查后端…'}</p>;
  }

  if (!backendRunning || !api) {
    return (
      <div className="setup">
        <div className="card">
          <h1>MissionPilot</h1>
          <p className="sub">
            后端未在 127.0.0.1:8788 上运行。请在应用内启动（应用会将后端作为托管进程拉起），或自行启动后粘贴
            token。
          </p>
          {setupError && <p className="error">{setupError}</p>}
          <div className="form-row">
            <label>后端 JS（可选）</label>
            <input
              value={backendJs}
              placeholder="dist/src/server.js 的路径"
              onChange={(e) => setBackendJs(e.target.value)}
              style={{ flex: 1 }}
            />
          </div>
          {defaultBackendJs !== undefined && (
            <p className="sub">
              {defaultBackendJs ? (
                <>留空则使用：<span className="mono">{defaultBackendJs}</span></>
              ) : (
                '未找到后端 JS——请先运行 npm run build，或在上方粘贴路径。'
              )}
            </p>
          )}
          <div className="btn-row">
            <button className="btn" disabled={starting} onClick={() => void handleStartBackend()}>
              {starting ? '启动中…' : '启动后端'}
            </button>
          </div>
          <hr style={{ margin: '20px 0', border: 'none', borderTop: '1px solid var(--border)' }} />
          <p className="sub">或连接到已在运行的后端：</p>
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
              连接
            </button>
          </div>
          <p className="sub" style={{ marginTop: 16 }}>
            手动启动：{' '}
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
    <div className={`app${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="brand"><img src={brandIcon} alt="" className="brand-icon" /><span className="brand-text">MissionPilot</span></div>
        {NAV.map((n) => (
          <button
            key={n.id}
            className={`nav-btn ${page === n.id || (n.id === 'overview' && (page === 'mission' || page === 'attempt')) ? 'active' : ''}`}
            onClick={() => setNav({ page: n.id })}
            title={sidebarCollapsed ? n.label : undefined}
          >
            <span className="nav-icon">{n.icon}</span>
            <span className="nav-label">{n.label}</span>
            {n.id === 'approvals' && pendingCount > 0 && (
              sidebarCollapsed ? (
                <span className="badge-dot" title={`${pendingCount} 条待审批`} />
              ) : (
                <span className="badge">{pendingCount}</span>
              )
            )}
          </button>
        ))}
        {sidebarCollapsed ? (
          <div className="sidebar-dots">
            <span className="status-dot ok" title={`后端：${statusLabel('running')}`} />
            <span className={`status-dot ${tunnelState ?? 'disabled'}`} title={`隧道：${tunnelState ? statusLabel(tunnelState) : '—'}`} />
            {pendingCount > 0 && <span className="status-dot pending" title={`待审批：${pendingCount}`} />}
          </div>
        ) : (
          <div className="sidebar-section">
            <div className="conn-row">
              <span>后端</span>
              <span className="pill connected">{statusLabel('running')}</span>
            </div>
            <div className="conn-row">
              <span>隧道</span>
              <span className={`pill ${tunnelState ?? 'disabled'}`}>{tunnelState ? statusLabel(tunnelState) : '—'}</span>
            </div>
            <div className="conn-row">
              <span>待审批</span>
              <span>{pendingCount}</span>
            </div>
          </div>
        )}
      </aside>
      <div className="content">
        <header className="topbar">
          <button
            className="icon-btn"
            onClick={() => setSidebarCollapsed((c) => !c)}
            title={sidebarCollapsed ? '展开导航栏' : '收起导航栏'}
            aria-label={sidebarCollapsed ? '展开导航栏' : '收起导航栏'}
          >
            <Icon>
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M9 3v18" />
              {sidebarCollapsed ? <path d="m14 9 3 3-3 3" /> : <path d="m10 9-3 3 3 3" />}
            </Icon>
          </button>
          <button
            className="icon-btn theme-btn"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            title={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
            aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          >
            <Icon>
              {theme === 'dark' ? (
                <>
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2" /><path d="M12 20v2" />
                  <path d="m4.9 4.9 1.4 1.4" /><path d="m17.7 17.7 1.4 1.4" />
                  <path d="M2 12h2" /><path d="M20 12h2" />
                  <path d="m6.3 17.7-1.4 1.4" /><path d="m19.1 4.9-1.4 1.4" />
                </>
              ) : (
                <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
              )}
            </Icon>
          </button>
        </header>
        <main className="main">
          {page === 'overview' && (
            <Overview api={api} events={events} onNavigate={setNav} />
          )}
          {page === 'mission' && nav.missionId && (
            <MissionDetail api={api} missionId={nav.missionId} onNavigate={setNav} />
          )}
          {page === 'attempt' && nav.attemptId && <AttemptDetail api={api} attemptId={nav.attemptId} />}
          {page === 'approvals' && <Approvals api={api} onChanged={() => setSidebarTick((t) => t + 1)} />}
          {page === 'scoreboard' && <ScoreboardLedger api={api} />}
          {page === 'connections' && <Connections api={api} />}
        </main>
      </div>
    </div>
  );
}
