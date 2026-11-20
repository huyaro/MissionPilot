import { useEffect, useState } from 'react';
import type { Approval, BoardApi } from '../api';

export function Approvals(props: { api: BoardApi; onChanged: () => void }) {
  const { api, onChanged } = props;
  const [pending, setPending] = useState<Approval[]>([]);
  const [history, setHistory] = useState<Approval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => {
    api
      .approvals('pending')
      .then((r) => setPending(r.approvals))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    api
      .approvals()
      .then((r) => setHistory(r.approvals.filter((a) => a.status !== 'pending')))
      .catch(() => undefined);
  };

  useEffect(load, [api]);

  const decide = async (id: string, decision: 'approved' | 'rejected') => {
    const r = reason[id] ?? '';
    if (decision === 'rejected' && !r.trim()) {
      setError('Rejecting requires a reason.');
      return;
    }
    setBusy(id);
    setError(null);
    try {
      const result = await api.decideApproval(id, decision, r || undefined);
      if (result.push) {
        // Surface the honest push outcome (deferred when no remote exists).
        setError(null);
        if (!result.push.pushed) {
          setError(`Approved. Push: ${result.push.note}`);
        }
      }
      setReason((prev) => ({ ...prev, [id]: '' }));
      load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <h1>Approval center</h1>
      <p className="sub">
        Replan proposals and pushes wait here. Nothing leaves the local loop without your decision
        (INV-7).
      </p>
      {error && <p className="error">{error}</p>}
      <div className="card">
        <h2>Pending ({pending.length})</h2>
        {pending.length === 0 ? (
          <p className="sub">Nothing waiting for approval.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Kind</th>
                <th>Summary</th>
                <th>Reason (required to reject)</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pending.map((a) => (
                <tr key={a.id}>
                  <td>
                    <span className="pill pending">{a.kind}</span>
                  </td>
                  <td>{a.summary}</td>
                  <td>
                    <input
                      value={reason[a.id] ?? ''}
                      placeholder="reason…"
                      onChange={(e) => setReason((prev) => ({ ...prev, [a.id]: e.target.value }))}
                      style={{ width: 220 }}
                    />
                  </td>
                  <td>
                    <div className="btn-row">
                      <button
                        className="btn"
                        disabled={busy === a.id}
                        onClick={() => void decide(a.id, 'approved')}
                      >
                        Approve
                      </button>
                      <button
                        className="btn danger"
                        disabled={busy === a.id}
                        onClick={() => void decide(a.id, 'rejected')}
                      >
                        Reject
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h2>History</h2>
        {history.length === 0 ? (
          <p className="sub">No decisions yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Kind</th>
                <th>Summary</th>
                <th>Decision</th>
                <th>Reason</th>
                <th>Decided</th>
              </tr>
            </thead>
            <tbody>
              {history.map((a) => (
                <tr key={a.id}>
                  <td>{a.kind}</td>
                  <td>{a.summary}</td>
                  <td>
                    <span className={`pill ${a.status}`}>{a.status}</span>
                  </td>
                  <td>{a.reason ?? '—'}</td>
                  <td>{a.decidedAt ? new Date(a.decidedAt).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
