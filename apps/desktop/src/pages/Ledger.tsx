import { useEffect, useState } from 'react';
import type { BoardApi, LedgerEntry, MissionSummary } from '../api';

export function Ledger(props: { api: BoardApi }) {
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
    <div>
      <h1>Ledger</h1>
      <p className="sub">
        Budgets and the hash-chained audit trail.{' '}
        {chainOk === null ? (
          ''
        ) : chainOk ? (
          <span className="pill pass">chain verified</span>
        ) : (
          <span className="pill fail">chain broken at seq {badSeq}</span>
        )}
      </p>
      {error && <p className="error">{error}</p>}
      <div className="card">
        <h2>Budgets</h2>
        {missions.length === 0 ? (
          <p className="sub">No missions yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Mission</th>
                <th>Status</th>
                <th>Budget</th>
                <th>Tasks done</th>
              </tr>
            </thead>
            <tbody>
              {missions.map((m) => (
                <tr key={m.id}>
                  <td>{m.goal}</td>
                  <td>
                    <span className={`pill ${m.status}`}>{m.status}</span>
                  </td>
                  <td>{m.budget === null ? '—' : `${m.budget} units`}</td>
                  <td>
                    {m.doneTasks}/{m.taskCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h2>Audit trail ({entries.length})</h2>
        {entries.length === 0 ? (
          <p className="sub">No ledger entries yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Seq</th>
                <th>Time</th>
                <th>Type</th>
                <th>Detail</th>
                <th>Hash</th>
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
    </div>
  );
}
