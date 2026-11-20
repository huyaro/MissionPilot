import { useEffect, useState } from 'react';
import type { BoardApi, ExecutorInfo } from '../api';

const REASONING_LEVELS = ['low', 'medium', 'high'] as const;

export function Connections(props: { api: BoardApi }) {
  const { api } = props;
  const [data, setData] = useState<Awaited<ReturnType<BoardApi['connections']>> | null>(null);
  const [executors, setExecutors] = useState<ExecutorInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  // Local edits per executor: models as comma-separated text, default model, reasoning.
  const [edits, setEdits] = useState<
    Record<string, { modelsText: string; defaultModel: string; reasoning: string }>
  >({});

  const load = () => {
    api
      .connections()
      .then((r) => setData(r))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    api
      .executors()
      .then((r) => {
        setExecutors(r.executors);
        const next: Record<string, { modelsText: string; defaultModel: string; reasoning: string }> = {};
        for (const e of r.executors) {
          next[e.id] = {
            modelsText: (e.config?.models ?? []).join(', '),
            defaultModel: e.config?.defaultModel ?? '',
            reasoning: e.config?.reasoning ?? '',
          };
        }
        setEdits(next);
      })
      .catch(() => undefined);
  };

  useEffect(load, [api]);

  const save = async (id: string) => {
    const edit = edits[id];
    if (!edit) return;
    const models = edit.modelsText
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m.length > 0);
    setError(null);
    setSaved(null);
    try {
      await api.saveExecutorConfig(id, {
        models,
        defaultModel: edit.defaultModel.trim() || null,
        reasoning: (edit.reasoning || null) as 'low' | 'medium' | 'high' | null,
      });
      setSaved(`${id} config saved`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <h1>Connections</h1>
      <p className="sub">Brains, tunnel, and executors — and what model each executor should use.</p>
      {error && <p className="error">{error}</p>}
      {saved && <p style={{ color: 'var(--green)' }}>{saved}</p>}
      <div className="card">
        <h2>Brains</h2>
        {data === null ? (
          <p className="sub">Loading…</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Brain</th>
                <th>Transport</th>
                <th>Status</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {data.brains.map((b) => (
                <tr key={b.id}>
                  <td>
                    <strong>{b.label}</strong>
                  </td>
                  <td>{b.transport}</td>
                  <td>
                    <span className={`pill ${b.status}`}>{b.status}</span>
                  </td>
                  <td>{b.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h2>Tunnel</h2>
        {data?.tunnel === null || data?.tunnel === undefined ? (
          <p className="sub">
            Tunnel is disabled. To enable ChatGPT: set ORCHESTRATOR_TUNNEL_ID and
            ORCHESTRATOR_TUNNEL_API_KEY when starting the backend (see README). The backend
            manages tunnel-client as a subprocess — start it, watch it, restart it when it dies.
          </p>
        ) : (
          <table>
            <tbody>
              <tr>
                <td>Tunnel ID</td>
                <td className="mono">{data.tunnel.tunnelId}</td>
              </tr>
              <tr>
                <td>State</td>
                <td>
                  <span className={`pill ${data.tunnel.state}`}>{data.tunnel.state}</span>
                </td>
              </tr>
              <tr>
                <td>Health URL</td>
                <td className="mono">{data.tunnel.healthUrl ?? '—'}</td>
              </tr>
              <tr>
                <td>PID</td>
                <td>{data.tunnel.pid ?? '—'}</td>
              </tr>
              <tr>
                <td>Restarts</td>
                <td>{data.tunnel.restarts}</td>
              </tr>
              <tr>
                <td>Last error</td>
                <td>{data.tunnel.lastError ?? '—'}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h2>Executors</h2>
        <p className="sub">
          Model and reasoning level are recorded per executor. The CLI adapters do not pass model
          flags yet — the exact flags are unverified until the Mac pre-flight confirms them.
        </p>
        <table>
          <thead>
            <tr>
              <th>Executor</th>
              <th>Status</th>
              <th>Models (comma-separated)</th>
              <th>Default model</th>
              <th>Reasoning</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {executors.map((e) => {
              const edit = edits[e.id] ?? { modelsText: '', defaultModel: '', reasoning: '' };
              const editable = e.id === 'codebuddy' || e.id === 'qoder';
              return (
                <tr key={e.id}>
                  <td>
                    <strong>{e.label}</strong>
                  </td>
                  <td>
                    <span className={`pill ${e.state}`}>{e.state}</span>
                  </td>
                  <td>
                    <input
                      value={edit.modelsText}
                      disabled={!editable}
                      placeholder={editable ? 'model-a, model-b' : '—'}
                      onChange={(ev) =>
                        setEdits((prev) => ({
                          ...prev,
                          [e.id]: { ...edit, modelsText: ev.target.value },
                        }))
                      }
                      style={{ width: 220 }}
                    />
                  </td>
                  <td>
                    <input
                      value={edit.defaultModel}
                      disabled={!editable}
                      placeholder="default model"
                      onChange={(ev) =>
                        setEdits((prev) => ({
                          ...prev,
                          [e.id]: { ...edit, defaultModel: ev.target.value },
                        }))
                      }
                      style={{ width: 140 }}
                    />
                  </td>
                  <td>
                    <select
                      value={edit.reasoning}
                      disabled={!editable}
                      onChange={(ev) =>
                        setEdits((prev) => ({
                          ...prev,
                          [e.id]: { ...edit, reasoning: ev.target.value },
                        }))
                      }
                    >
                      <option value="">—</option>
                      {REASONING_LEVELS.map((l) => (
                        <option key={l} value={l}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {editable && (
                      <button className="btn secondary" onClick={() => void save(e.id)}>
                        Save
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="sub" style={{ marginTop: 12 }}>
          WorkBuddy is pending (no CLI; the pi route is out of scope for this project). Gemini is
          not connected — wrapping the consumer CLI is unsupported by its ToS.
        </p>
      </div>
    </div>
  );
}
