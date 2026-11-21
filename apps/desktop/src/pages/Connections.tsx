import { useEffect, useState } from 'react';
import type { BoardApi, ExecutorInfo } from '../api';
import { statusLabel } from '../labels';

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
      setSaved(`${id} 配置已保存`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <h1>连接</h1>
      <p className="sub">大脑、隧道与执行者——以及各执行者应使用的模型。</p>
      {error && <p className="error">{error}</p>}
      {saved && <p style={{ color: 'var(--green)' }}>{saved}</p>}
      <div className="card">
        <h2>大脑</h2>
        {data === null ? (
          <p className="sub">加载中…</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>大脑</th>
                <th>传输方式</th>
                <th>状态</th>
                <th>说明</th>
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
                    <span className={`pill ${b.status}`}>{statusLabel(b.status)}</span>
                  </td>
                  <td>{b.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h2>隧道</h2>
        {data?.tunnel === null || data?.tunnel === undefined ? (
          <p className="sub">
            隧道未启用。要启用 ChatGPT：启动后端时设置 ORCHESTRATOR_TUNNEL_ID 与
            ORCHESTRATOR_TUNNEL_API_KEY（见 README）。后端将 tunnel-client 作为子进程管理——启动、看守、挂了重启。
          </p>
        ) : (
          <table>
            <tbody>
              <tr>
                <td>隧道 ID</td>
                <td className="mono">{data.tunnel.tunnelId}</td>
              </tr>
              <tr>
                <td>状态</td>
                <td>
                  <span className={`pill ${data.tunnel.state}`}>{statusLabel(data.tunnel.state)}</span>
                </td>
              </tr>
              <tr>
                <td>健康检查 URL</td>
                <td className="mono">{data.tunnel.healthUrl ?? '—'}</td>
              </tr>
              <tr>
                <td>PID</td>
                <td>{data.tunnel.pid ?? '—'}</td>
              </tr>
              <tr>
                <td>重启次数</td>
                <td>{data.tunnel.restarts}</td>
              </tr>
              <tr>
                <td>最近错误</td>
                <td>{data.tunnel.lastError ?? '—'}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h2>执行者</h2>
        <p className="sub">
          模型与推理等级按执行者记录。CLI 适配器暂不传递模型参数——具体参数需等 Mac 预检确认。
        </p>
        <table>
          <thead>
            <tr>
              <th>执行者</th>
              <th>状态</th>
              <th>模型（逗号分隔）</th>
              <th>默认模型</th>
              <th>推理等级</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {executors
              .filter((e) => e.id === 'codebuddy' || e.id === 'qoder')
              .map((e) => {
              const edit = edits[e.id] ?? { modelsText: '', defaultModel: '', reasoning: '' };
              const editable = e.id === 'codebuddy' || e.id === 'qoder';
              return (
                <tr key={e.id}>
                  <td>
                    <strong>{e.label}</strong>
                  </td>
                  <td>
                    <span className={`pill ${e.state}`}>{statusLabel(e.state)}</span>
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
                      placeholder="默认模型"
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
                        保存
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
