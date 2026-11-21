import { useEffect, useState } from 'react';
import type { BoardApi, TaskDetail } from '../api';
import type { NavTarget } from './Overview';
import { statusLabel } from '../labels';

/** Topological order by dependency depth (plan validation already rejects cycles). */
function topoOrder(tasks: TaskDetail[]): TaskDetail[] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const depth = new Map<string, number>();
  const visit = (t: TaskDetail, seen: Set<string>): number => {
    if (depth.has(t.key)) return depth.get(t.key) as number;
    if (seen.has(t.key)) return 0;
    seen.add(t.key);
    const d =
      t.dependsOn.length === 0
        ? 0
        : 1 + Math.max(...t.dependsOn.map((k) => visit(byKey.get(k) ?? t, seen)));
    depth.set(t.key, d);
    return d;
  };
  return [...tasks].sort((a, b) => visit(a, new Set()) - visit(b, new Set()));
}

export function MissionDetail(props: {
  api: BoardApi;
  missionId: string;
  onNavigate: (t: NavTarget) => void;
}) {
  const { api, missionId, onNavigate } = props;
  const [data, setData] = useState<Awaited<ReturnType<BoardApi['missionDetail']>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .missionDetail(missionId)
      .then((r) => alive && setData(r))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [api, missionId]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="sub">正在加载任务…</p>;
  const { mission, tasks, proposals, budget } = data;
  const ordered = topoOrder(tasks);
  const budgetPct =
    budget.limit && budget.limit > 0 ? Math.min(100, Math.round((budget.estimated / budget.limit) * 100)) : null;
  return (
    <div>
      <h1>{mission.goal}</h1>
      <p className="sub">
        <span className={`pill ${mission.status}`}>{statusLabel(mission.status)}</span>{' '}
        <span className="mono">{mission.id}</span> · {mission.source} · {mission.repo}
      </p>
      <div className="two-col">
        <div className="card">
          <h2>任务依赖图</h2>
          <div className="dag">
            {ordered.map((t) => (
              <div className="dag-node" key={t.id}>
                <span className={`dag-dot ${t.status}`} />
                <div style={{ flex: 1 }}>
                  <div>
                    <strong>{t.title}</strong>{' '}
                    <span className={`pill ${t.status}`}>{statusLabel(t.status)}</span>{' '}
                    {t.rerouted && <span className="pill pending">已换人</span>}{' '}
                    {t.revisionsUsed > 0 && <span className="pill pending">修订 ×{t.revisionsUsed}</span>}
                  </div>
                  <div className="sub" style={{ margin: 0 }}>
                    {t.key}
                    {t.dependsOn.length > 0 ? ` · 依赖 ${t.dependsOn.join(', ')}` : ' · 无依赖'}
                    {t.estimate !== null ? ` · 预计 ${t.estimate}` : ''}
                    {t.attempts > 0 ? ` · ${t.attempts} 次尝试` : ''}
                  </div>
                  {t.latestAttempt && (
                    <div className="form-row" style={{ margin: '6px 0 0' }}>
                      <span className="mono">
                        {t.latestAttempt.agent} · {statusLabel(t.latestAttempt.status)}
                        {t.latestAttempt.exitCode !== null ? ` · 退出码 ${t.latestAttempt.exitCode}` : ''}
                      </span>
                      <button
                        className="btn secondary"
                        onClick={() =>
                          onNavigate({ page: 'attempt', attemptId: t.latestAttempt?.id })
                        }
                      >
                        尝试详情
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="card">
            <h2>预算</h2>
            {budget.limit === null ? (
              <p className="sub">未设置预算，预计总计：{budget.estimated} 单位。</p>
            ) : (
              <>
                <div>
                  预计 {budget.estimated} / {budget.limit} 单位
                </div>
                <div className="budget-bar" style={{ marginTop: 8 }}>
                  <div style={{ width: `${budgetPct ?? 0}%` }} />
                </div>
              </>
            )}
          </div>
          <div className="card">
            <h2>契约与验收标准</h2>
            {ordered.map((t) => (
              <div key={t.id} style={{ marginBottom: 12 }}>
                <strong>{t.title}</strong>
                <div className="sub" style={{ margin: '2px 0' }}>
                  契约：{t.contract}
                </div>
                <div className="sub" style={{ margin: 0 }}>
                  验收标准：{t.acceptance || '—'}
                </div>
              </div>
            ))}
          </div>
          {proposals.length > 0 && (
            <div className="card">
              <h2>重新规划提案</h2>
              {proposals.map((p) => (
                <div key={p.id} className="sub">
                  {p.reason}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
