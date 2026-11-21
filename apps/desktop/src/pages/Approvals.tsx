import { useEffect, useState } from 'react';
import type { Approval, BoardApi } from '../api';
import { kindLabel, statusLabel } from '../labels';

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
      setError('拒绝需要填写理由。');
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
          setError(`已批准。推送：${result.push.note}`);
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
      <h1>审批中心</h1>
      <p className="sub">
        重新规划提案与推送在此等候。没有你的决定，任何内容都不会离开本地闭环（INV-7）。
      </p>
      {error && <p className="error">{error}</p>}
      <div className="card">
        <h2>待审批 ({pending.length})</h2>
        {pending.length === 0 ? (
          <p className="sub">暂无待审批项。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>类型</th>
                <th>摘要</th>
                <th>理由（拒绝必填）</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pending.map((a) => (
                <tr key={a.id}>
                  <td>
                    <span className="pill pending">{kindLabel(a.kind)}</span>
                  </td>
                  <td>{a.summary}</td>
                  <td>
                    <input
                      value={reason[a.id] ?? ''}
                      placeholder="理由…"
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
                        批准
                      </button>
                      <button
                        className="btn danger"
                        disabled={busy === a.id}
                        onClick={() => void decide(a.id, 'rejected')}
                      >
                        拒绝
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
        <h2>历史记录</h2>
        {history.length === 0 ? (
          <p className="sub">暂无决定记录。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>类型</th>
                <th>摘要</th>
                <th>决定</th>
                <th>理由</th>
                <th>决定时间</th>
              </tr>
            </thead>
            <tbody>
              {history.map((a) => (
                <tr key={a.id}>
                  <td>{kindLabel(a.kind)}</td>
                  <td>{a.summary}</td>
                  <td>
                    <span className={`pill ${a.status}`}>{statusLabel(a.status)}</span>
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
