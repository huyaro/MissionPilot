import { useEffect, useState } from 'react';
import type { BoardApi, BoardEventMsg, MissionSummary } from '../api';
import { statusLabel } from '../labels';

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
      <h1>总览</h1>
      <p className="sub">任务、实时动态，以及需要你决定的事项。</p>
      {error && <p className="error">{error}</p>}
      <div className="grid">
        <div className="kpi">
          <div className="label">进行中的任务</div>
          <div className="value">{active.length}</div>
        </div>
        <div className="kpi">
          <div className="label">任务总数</div>
          <div className="value">{missions.length}</div>
        </div>
        <div className="kpi">
          <div className="label">待审批</div>
          <div className="value">{pendingApprovals}</div>
        </div>
        <div className="kpi">
          <div className="label">失败任务</div>
          <div className="value">{failedTasks}</div>
        </div>
      </div>
      <div className="two-col">
        <div className="card">
          <h2>任务</h2>
          {missions.length === 0 ? (
            <p className="sub">暂无任务。从 Codex 或 ChatGPT 派发一个。</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>目标</th>
                  <th>状态</th>
                  <th>任务</th>
                  <th>来源</th>
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
                      <span className={statusPill(m.status)}>{statusLabel(m.status)}</span>
                    </td>
                    <td>
                      {m.doneTasks}/{m.taskCount}
                      {m.failedTasks > 0 ? ` （${m.failedTasks} 个失败）` : ''}
                    </td>
                    <td>{m.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="card">
          <h2>实时动态</h2>
          {events.length === 0 ? (
            <p className="sub">等待后端事件（SSE）…</p>
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
