import { useEffect, useState } from 'react';
import type { BoardApi, ExecutorInfo } from '../api';
import { statusLabel } from '../labels';

const REASONING_LEVELS = ['low', 'medium', 'high'] as const;

export function Connections(props: { api: BoardApi; onChanged?: () => void }) {
  const { api, onChanged } = props;
  const [data, setData] = useState<Awaited<ReturnType<BoardApi['connections']>> | null>(null);
  const [executors, setExecutors] = useState<ExecutorInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  // Tunnel config (Settings UI): the key is persisted to the saved
  // tunnel config on the backend; the input is never prefilled with it.
  const [tunnelId, setTunnelId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  // Tunnel start/stop failure, shown inline next to the button.
  const [tunnelError, setTunnelError] = useState<string | null>(null);
  // Local edits per executor: chosen default model + reasoning level.
  // The model list itself is never typed — it comes from the agent.
  const [edits, setEdits] = useState<
    Record<string, { defaultModel: string; reasoning: string }>
  >({});
  // Model list per executor, fetched from the agent's own mechanism.
  type ModelsState =
    | { status: 'loading' }
    | { status: 'ready'; models: string[]; source: string }
    | { status: 'error'; error: string };
  const [modelsState, setModelsState] = useState<Record<string, ModelsState>>({});
  const [showAdd, setShowAdd] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchModels = (id: string, force = false) => {
    setModelsState((prev) => {
      if (!force && prev[id]) return prev;
      return { ...prev, [id]: { status: 'loading' } };
    });
    api
      .executorModels(id)
      .then((r) =>
        setModelsState((prev) => ({
          ...prev,
          [id]: { status: 'ready', models: r.models, source: r.source },
        })),
      )
      .catch((e: unknown) =>
        setModelsState((prev) => ({
          ...prev,
          [id]: { status: 'error', error: e instanceof Error ? e.message : String(e) },
        })),
      );
  };

  const load = () => {
    api
      .connections()
      .then((r) => {
        setData(r);
        // Prefill the tunnel id from the env default / current config,
        // but never overwrite what the user has already typed.
        setTunnelId((prev) => prev || r.tunnelConfig?.tunnelId || '');
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    api
      .executors()
      .then((r) => {
        setExecutors(r.executors);
        const next: Record<string, { defaultModel: string; reasoning: string }> = {};
        for (const e of r.executors) {
          next[e.id] = {
            defaultModel: e.config?.defaultModel ?? '',
            reasoning: e.config?.reasoning ?? '',
          };
        }
        setEdits(next);
        for (const e of r.executors) {
          if (e.added) fetchModels(e.id);
        }
      })
      .catch(() => undefined);
  };

  useEffect(load, [api]);

  const save = async (id: string) => {
    const edit = edits[id];
    if (!edit) return;
    const ms = modelsState[id];
    const executor = executors.find((e) => e.id === id);
    // Save the fetched catalogue as `models`; when the fetch failed, keep
    // the previously saved list so the saved default still validates.
    const models = ms?.status === 'ready' ? ms.models : (executor?.config?.models ?? []);
    // A default that is no longer on the fetched list falls back to the
    // CLI default instead of failing the save (the UI says so, see below).
    const chosen =
      ms?.status === 'ready' && edit.defaultModel.trim() !== '' && !ms.models.includes(edit.defaultModel.trim())
        ? ''
        : edit.defaultModel.trim();
    setError(null);
    setSaved(null);
    setBusyId(id);
    try {
      await api.saveExecutorConfig(id, {
        models,
        defaultModel: chosen || null,
        reasoning: (edit.reasoning || null) as 'low' | 'medium' | 'high' | null,
      });
      setSaved(`${id} 配置已保存`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const addExecutor = async (id: string) => {
    setAddError(null);
    setBusyId(id);
    try {
      // Adding = creating the saved config row (empty); the model list
      // is fetched right after, via load().
      await api.saveExecutorConfig(id, {});
      setSaved(`${id} 已添加`);
      load();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const removeExecutor = async (id: string) => {
    // Two-step confirm: first click arms, second click removes.
    if (confirmRemove !== id) {
      setConfirmRemove(id);
      return;
    }
    setConfirmRemove(null);
    setBusyId(id);
    try {
      await api.removeExecutorConfig(id);
      setSaved(`${id} 已移除，可随时重新添加`);
      setModelsState((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const startTunnel = async () => {
    const savedId = data?.tunnelConfig?.tunnelId ?? '';
    const hasSavedKey = data?.tunnelConfig?.apiKeySet ?? false;
    if (!tunnelId.trim() && !savedId) {
      setTunnelError('请填写 Tunnel ID');
      return;
    }
    if (!apiKey.trim() && !hasSavedKey) {
      setTunnelError('请填写 API 密钥');
      return;
    }
    setTunnelError(null);
    setStarting(true);
    try {
      // Empty fields mean "use the saved config" — the key is never
      // echoed back, so the input cannot prefill it.
      const r = await api.startTunnel(tunnelId.trim(), apiKey.trim());
      // The key now lives in backend memory (and the saved config);
      // don't keep it in the input.
      setApiKey('');
      if (r.tunnel.state === 'failed') {
        setTunnelError(r.tunnel.lastError ?? '隧道启动失败，请检查 Tunnel ID 与 API key 是否正确。');
      }
      load();
      // Refresh the sidebar pill immediately — it used to wait for the
      // next 10s poll, which is the lag the user saw.
      onChanged?.();
    } catch (e) {
      setTunnelError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const stopTunnel = async () => {
    setTunnelError(null);
    setStopping(true);
    try {
      await api.stopTunnel();
      load();
      onChanged?.();
    } catch (e) {
      setTunnelError(e instanceof Error ? e.message : String(e));
    } finally {
      setStopping(false);
    }
  };

  // Tunnel counts as up while its process is starting, running, or
  // reconnecting; 'failed' / 'stopped' / absent means it can be started.
  const tunnelActive =
    data?.tunnel != null && data.tunnel.state !== 'failed' && data.tunnel.state !== 'stopped';
  // Starting needs an ID and a key — each from the input, or from the
  // saved config when the input is empty.
  const canStartTunnel =
    (tunnelId.trim() !== '' || (data?.tunnelConfig?.tunnelId ?? '') !== '') &&
    (apiKey.trim() !== '' || (data?.tunnelConfig?.apiKeySet ?? false));
  // Added = has a saved config row; candidates = CLI agents not yet added.
  const addedExecutors = executors.filter((e) => e.added);
  const addCandidates = executors.filter(
    (e) => (e.id === 'codebuddy' || e.id === 'qoder') && !e.added,
  );

  return (
    <div>
      <h1>设置</h1>
      <p className="sub">主脑、执行者、隧道——以及各执行者应使用的模型。</p>
      {error && <p className="error">{error}</p>}
      {saved && <p style={{ color: 'var(--green)' }}>{saved}</p>}
      <div className="card">
        <h2>主脑</h2>
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>执行者</h2>
          <button className="btn secondary" onClick={() => setShowAdd((v) => !v)}>
            {showAdd ? '收起' : '添加'}
          </button>
        </div>
        <p className="sub">
          模型从各执行者本机取回（Qoder：qoder --list-models；CodeBuddy：~/.codebuddy/models.json），下拉选择后保存到本地配置。CLI
          适配器暂不向派发传递模型参数，待 Mac 预检确认。
        </p>
        {showAdd && (
          <div>
            {addCandidates.length === 0 ? (
              <p className="sub">本地检测到的执行者都已添加。</p>
            ) : (
              <table>
                <tbody>
                  {addCandidates.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <strong>{e.label}</strong>
                      </td>
                      <td>
                        <span className={`pill ${e.state}`}>{statusLabel(e.state)}</span>
                      </td>
                      <td className="sub">
                        {e.detected ? '已检测到' : `未检测到（PATH 中没有 ${e.id}）`}
                      </td>
                      <td>
                        <button
                          className="btn secondary"
                          disabled={!e.detected || busyId === e.id}
                          onClick={() => void addExecutor(e.id)}
                        >
                          {busyId === e.id ? '添加中…' : '添加'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {addError && <p className="error">{addError}</p>}
          </div>
        )}
        {addedExecutors.length === 0 ? (
          <p className="sub">尚未添加执行者。点「添加」从本地检测到的 agent 里挑一个。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>执行者</th>
                <th>状态</th>
                <th>模型</th>
                <th>推理等级</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {addedExecutors.map((e) => {
                const edit = edits[e.id] ?? { defaultModel: '', reasoning: '' };
                const ms = modelsState[e.id];
                const staleDefault =
                  edit.defaultModel !== '' &&
                  ms?.status === 'ready' &&
                  !ms.models.includes(edit.defaultModel);
                return (
                  <tr key={e.id}>
                    <td>
                      <strong>{e.label}</strong>
                    </td>
                    <td>
                      <span className={`pill ${e.state}`}>{statusLabel(e.state)}</span>
                    </td>
                    <td>
                      {ms === undefined || ms.status === 'loading' ? (
                        <span className="sub">加载模型中…</span>
                      ) : ms.status === 'error' ? (
                        <span>
                          <span className="error">模型列表获取失败</span>{' '}
                          <button className="btn secondary" onClick={() => fetchModels(e.id, true)}>
                            重试
                          </button>
                          <br />
                          <span className="sub">{ms.error}</span>
                        </span>
                      ) : (
                        <span>
                          <select
                            value={ms.models.includes(edit.defaultModel) ? edit.defaultModel : ''}
                            onChange={(ev) =>
                              setEdits((prev) => ({
                                ...prev,
                                [e.id]: { ...edit, defaultModel: ev.target.value },
                              }))
                            }
                            style={{ width: 220 }}
                          >
                            <option value="">使用 CLI 默认模型</option>
                            {ms.models.map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                          </select>
                          <br />
                          <span className="sub">来源：{ms.source}</span>
                          {staleDefault && (
                            <>
                              <br />
                              <span className="error">
                                之前选的 {edit.defaultModel}{' '}
                                已不在当前列表中，保存时会改用 CLI 默认模型
                              </span>
                            </>
                          )}
                        </span>
                      )}
                    </td>
                    <td>
                      <select
                        value={edit.reasoning}
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
                      <button
                        className="btn secondary"
                        disabled={busyId === e.id}
                        onClick={() => void save(e.id)}
                      >
                        {busyId === e.id ? '保存中…' : '保存'}
                      </button>{' '}
                      <button
                        className="btn secondary"
                        disabled={busyId === e.id}
                        onClick={() => void removeExecutor(e.id)}
                      >
                        {confirmRemove === e.id ? '确认移除？' : '移除'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h2>隧道</h2>
        {data?.tunnel ? (
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
        ) : (
          <p className="sub">隧道未启用。填写下面的 Tunnel ID 与 API key，点「启动隧道」。</p>
        )}
        <div className="form-row">
          <label>隧道 ID</label>
          <input
            value={tunnelId}
            onChange={(ev) => setTunnelId(ev.target.value)}
            placeholder="tunnel_..."
            style={{ width: 280 }}
          />
        </div>
        <div className="form-row">
          <label>API 密钥</label>
          <input
            type="password"
            value={apiKey}
            onChange={(ev) => setApiKey(ev.target.value)}
            placeholder={
              data?.tunnelConfig?.apiKeySet ? '已保存，留空使用已保存的密钥' : '输入 API 密钥'
            }
            style={{ width: 280 }}
          />
        </div>
        <div className="btn-row">
          {tunnelActive ? (
            <button className="btn danger" disabled={stopping} onClick={() => void stopTunnel()}>
              {stopping ? '停止中…' : '停止隧道'}
            </button>
          ) : (
            <button
              className="btn"
              disabled={starting || !canStartTunnel}
              onClick={() => void startTunnel()}
            >
              {starting ? '启动中…' : '启动隧道'}
            </button>
          )}
          {tunnelError && <span className="error">{tunnelError}</span>}
        </div>
      </div>
    </div>
  );
}
