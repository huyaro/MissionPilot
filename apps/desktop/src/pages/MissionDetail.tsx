import { useEffect, useState } from 'react';
import type { BoardApi, TaskDetail } from '../api';
import type { NavTarget } from './Overview';

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
  if (!data) return <p className="sub">Loading mission…</p>;
  const { mission, tasks, proposals, budget } = data;
  const ordered = topoOrder(tasks);
  const budgetPct =
    budget.limit && budget.limit > 0 ? Math.min(100, Math.round((budget.estimated / budget.limit) * 100)) : null;
  return (
    <div>
      <h1>{mission.goal}</h1>
      <p className="sub">
        <span className={`pill ${mission.status}`}>{mission.status}</span>{' '}
        <span className="mono">{mission.id}</span> · {mission.source} · {mission.repo}
      </p>
      <div className="two-col">
        <div className="card">
          <h2>Task DAG</h2>
          <div className="dag">
            {ordered.map((t) => (
              <div className="dag-node" key={t.id}>
                <span className={`dag-dot ${t.status}`} />
                <div style={{ flex: 1 }}>
                  <div>
                    <strong>{t.title}</strong>{' '}
                    <span className={`pill ${t.status}`}>{t.status}</span>{' '}
                    {t.rerouted && <span className="pill pending">rerouted</span>}{' '}
                    {t.revisionsUsed > 0 && <span className="pill pending">revise ×{t.revisionsUsed}</span>}
                  </div>
                  <div className="sub" style={{ margin: 0 }}>
                    {t.key}
                    {t.dependsOn.length > 0 ? ` · depends on ${t.dependsOn.join(', ')}` : ' · no dependencies'}
                    {t.estimate !== null ? ` · estimate ${t.estimate}` : ''}
                    {t.attempts > 0 ? ` · ${t.attempts} attempt${t.attempts > 1 ? 's' : ''}` : ''}
                  </div>
                  {t.latestAttempt && (
                    <div className="form-row" style={{ margin: '6px 0 0' }}>
                      <span className="mono">
                        {t.latestAttempt.agent} · {t.latestAttempt.status}
                        {t.latestAttempt.exitCode !== null ? ` · exit ${t.latestAttempt.exitCode}` : ''}
                      </span>
                      <button
                        className="btn secondary"
                        onClick={() =>
                          onNavigate({ page: 'attempt', attemptId: t.latestAttempt?.id })
                        }
                      >
                        Attempt detail
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
            <h2>Budget</h2>
            {budget.limit === null ? (
              <p className="sub">No budget set. Estimated total: {budget.estimated} units.</p>
            ) : (
              <>
                <div>
                  Estimated {budget.estimated} / {budget.limit} units
                </div>
                <div className="budget-bar" style={{ marginTop: 8 }}>
                  <div style={{ width: `${budgetPct ?? 0}%` }} />
                </div>
              </>
            )}
          </div>
          <div className="card">
            <h2>Contract &amp; acceptance</h2>
            {ordered.map((t) => (
              <div key={t.id} style={{ marginBottom: 12 }}>
                <strong>{t.title}</strong>
                <div className="sub" style={{ margin: '2px 0' }}>
                  Contract: {t.contract}
                </div>
                <div className="sub" style={{ margin: 0 }}>
                  Acceptance: {t.acceptance || '—'}
                </div>
              </div>
            ))}
          </div>
          {proposals.length > 0 && (
            <div className="card">
              <h2>Replan proposals</h2>
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
