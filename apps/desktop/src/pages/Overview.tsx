import { useEffect, useState } from 'react';
import type { BoardApi, BoardEventMsg, MissionSummary } from '../api';

export type NavTarget = { page: string; missionId?: string; attemptId?: string };

function statusPill(status: string): string {
  return `pill ${status}`;
}

export function Overview(props: {
  api: BoardApi;
  events: BoardEventMsg[];
  onNavigate: (t: NavTarget) => void;
}) {
  const { api, events, onNavigate } = props;
  const [missions, setMissions] = useState<MissionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .listMissions()
      .then((r) => alive && setMissions(r.missions))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    api
      .approvals('pending')
      .then((r) => alive && setPendingApprovals(r.approvals.length))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api, events.length]);

  const active = missions.filter((m) => m.status === 'planned' || m.status === 'executing');
  const failedTasks = missions.reduce((sum, m) => sum + m.failedTasks, 0);
  return (
    <div>
      <h1>Overview</h1>
      <p className="sub">Missions, live activity, and what needs your decision.</p>
      {error && <p className="error">{error}</p>}
      <div className="grid">
        <div className="kpi">
          <div className="label">Active missions</div>
          <div className="value">{active.length}</div>
        </div>
        <div className="kpi">
          <div className="label">Missions total</div>
          <div className="value">{missions.length}</div>
        </div>
        <div className="kpi">
          <div className="label">Pending approvals</div>
          <div className="value">{pendingApprovals}</div>
        </div>
        <div className="kpi">
          <div className="label">Failed tasks</div>
          <div className="value">{failedTasks}</div>
        </div>
      </div>
      <div className="two-col">
        <div className="card">
          <h2>Missions</h2>
          {missions.length === 0 ? (
            <p className="sub">No missions yet. Dispatch one from Codex or ChatGPT.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Goal</th>
                  <th>Status</th>
                  <th>Tasks</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {missions.map((m) => (
                  <tr
                    key={m.id}
                    className="clickable"
                    onClick={() => onNavigate({ page: 'mission', missionId: m.id })}
                  >
                    <td>{m.goal}</td>
                    <td>
                      <span className={statusPill(m.status)}>{m.status}</span>
                    </td>
                    <td>
                      {m.doneTasks}/{m.taskCount}
                      {m.failedTasks > 0 ? ` (${m.failedTasks} failed)` : ''}
                    </td>
                    <td>{m.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="card">
          <h2>Live activity</h2>
          {events.length === 0 ? (
            <p className="sub">Waiting for backend events (SSE)…</p>
          ) : (
            <div className="event-list">
              {events.slice(0, 12).map((e, i) => (
                <div className="event-row" key={`${e.ts}-${i}`}>
                  <span className="ts">{new Date(e.ts).toLocaleTimeString()}</span>
                  <span>
                    <strong>{e.type.replaceAll('_', ' ')}</strong> — {e.summary}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
