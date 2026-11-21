import { useEffect, useState } from 'react';
import type { BoardApi, LedgerEntry, MissionSummary } from '../api';
import { statusLabel } from '../labels';

// Ledger as a card (used by the merged 记分板与账本 page). Keeps its own
// data fetching; the page title lives in the parent page.
export function LedgerCard(props: { api: BoardApi }) {
  const { api } = props;
  const [missions, setMissions] = useState<MissionSummary[]>([]);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [chainOk, setChainOk] = useState<boolean | null>(null);
  const [badSeq, setBadSeq] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .listMissions()
      .then((r) => alive && setMissions(r.missions))
      .catch(() => undefined);
    api
      .ledger()
      .then((r) => {
        if (!alive) return;
        setEntries(r.entries);
        setChainOk(r.chain.ok);
        setBadSeq(r.chain.badSeq);
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [api]);

  return (
    <div className="card">
      <h2>账本</h2>
      <p className="sub">
        预算与哈希链审计记录。{' '}
        {chainOk === null ? (
          ''
        ) : chainOk ? (
          <span className="pill pass">链已验证</span>
        ) : (
          <span className="pill fail">链在序号 {badSeq} 处断裂</span>
        )}
      </p>
      {error && <p className="error">{error}</p>}
      <h3>预算</h3>
        {missions.length === 0 ? (
          <p className="sub">暂无任务。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>任务</th>
                <th>状态</th>
                <th>预算</th>
                <th>已完成任务</th>
              </tr>
            </thead>
            <tbody>
              {missions.map((m) => (
                <tr key={m.id}>
                  <td>{m.goal}</td>
                  <td>
                    <span className={`pill ${m.status}`}>{statusLabel(m.status)}</span>
                  </td>
                  <td>{m.budget === null ? '—' : `${m.budget} 单位`}</td>
                  <td>
                    {m.doneTasks}/{m.taskCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      <h3>审计记录 ({entries.length})</h3>
        {entries.length === 0 ? (
          <p className="sub">暂无账本记录。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>序号</th>
                <th>时间</th>
                <th>类型</th>
                <th>详情</th>
                <th>哈希</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.seq}>
                  <td>{e.seq}</td>
                  <td>{new Date(e.ts).toLocaleString()}</td>
                  <td>
                    <span className="pill created">{e.type}</span>
                  </td>
                  <td>{e.detail}</td>
                  <td className="hash">{e.hash.slice(0, 12)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </div>
  );
}
