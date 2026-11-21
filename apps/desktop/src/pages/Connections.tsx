import { useEffect, useState } from 'react';
import type { BoardApi, ConfigModel, ExecutorInfo } from '../api';
import { statusLabel } from '../labels';

const REASONING_LABELS: Record<ConfigModel['reasoning'], string> = {
  low: '低',
  medium: '中',
  high: '高',
};
const CONTEXT_OPTIONS = ['32K', '64K', '128K', '200K', '400K', '1M'];

type Tab = 'brain' | 'executors' | 'tunnel';

export function Connections(props: { api: BoardApi; onChanged?: () => void }) {
  const { api, onChanged } = props;
  const [tab, setTab] = useState<Tab>('brain');
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
  // Local edits per executor: the configured model list (the array IS the
  // enabled set) + the default model + the enable/disable toggle. Never
  // typed — models come from the agent's own list mechanism.
  const [edits, setEdits] = useState<
    Record<string, { models: ConfigModel[]; defaultModel: string | null; enabled: boolean }>
  >({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Model chosen in the bottom dropdown ('' = none chosen yet).
  const [dropdownModel, setDropdownModel] = useState('');
  // Model list per executor, fetched from the agent's own mechanism.
  type ModelsState =
    | { status: 'loading' }
    | { status: 'ready'; models: string[]; source: string }
    | { status: 'error'; error: string };
  const [modelsState, setModelsState] = useState<Record<string, ModelsState>>({});
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

  // Connections only (tunnel state + saved config). Safe to poll: it
  // never touches the executor edit state.
  const loadConnections = () => {
    api
      .connections()
      .then((r) => {
        setData(r);
        // Prefill the tunnel id from the saved config, but never
        // overwrite what the user has already typed.
        setTunnelId((prev) => prev || r.tunnelConfig?.tunnelId || '');
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  // Executors + local edit state. NOT polled: rebuilding `edits` every
  // tick would wipe unsaved changes. `refresh` bypasses the backend's
  // 60s detection cache (the 重新检测 button).
  const loadExecutors = (refresh = false) => {
    api
      .executors(refresh)
      .then((r) => {
        setExecutors(r.executors);
        const next: Record<
          string,
          { models: ConfigModel[]; defaultModel: string | null; enabled: boolean }
        > = {};
        for (const e of r.executors) {
          next[e.id] = {
            models: e.config?.models ?? [],
            defaultModel: e.config?.defaultModel ?? null,
            // Rows predating the flag read as enabled.
            enabled: e.config?.enabled ?? true,
          };
        }
        setEdits(next);
        // Keep the selection when it still exists; otherwise pick the
        // first detected agent (the backend already sorts detected first).
        setSelectedId((prev) => {
          const keep = prev !== null && r.executors.some((e) => e.id === prev) ? prev : null;
          const chosen = keep ?? r.executors[0]?.id ?? null;
          if (chosen) fetchModels(chosen);
          return chosen;
        });
      })
      .catch(() => undefined);
  };

  const load = () => {
    loadConnections();
    loadExecutors();
  };

  useEffect(load, [api]);

  // The tunnel state can change on its own — starting -> running once
  // the health check passes, or dying / reconnecting later. The page
  // used to show a stale snapshot until the next action (the sidebar
  // polls, so it moved on while this table stayed on 启动中). Poll the
  // connections every 2s, same as the sidebar.
  useEffect(() => {
    const timer = setInterval(loadConnections, 2_000);
    return () => clearInterval(timer);
  }, [api]);

  const selectExecutor = (id: string) => {
    setSelectedId(id);
    setDropdownModel('');
    fetchModels(id);
  };

  const addModel = (agentId: string, modelId: string) => {
    setEdits((prev) => {
      const cur = prev[agentId] ?? { models: [], defaultModel: null, enabled: true };
      if (cur.models.some((m) => m.id === modelId)) return prev;
      const models = [...cur.models, { id: modelId, reasoning: 'high' as const, context: '128K' }];
      return {
        ...prev,
        [agentId]: { ...cur, models, defaultModel: cur.defaultModel ?? modelId },
      };
    });
  };

  const updateModel = (agentId: string, modelId: string, patch: Partial<ConfigModel>) => {
    setEdits((prev) => {
      const cur = prev[agentId];
      if (!cur) return prev;
      return {
        ...prev,
        [agentId]: {
          ...cur,
          models: cur.models.map((m) => (m.id === modelId ? { ...m, ...patch } : m)),
        },
      };
    });
  };

  const removeModel = (agentId: string, modelId: string) => {
    setEdits((prev) => {
      const cur = prev[agentId];
      if (!cur) return prev;
      const models = cur.models.filter((m) => m.id !== modelId);
      // Deleting the default falls back to the first remaining model.
      const defaultModel =
        cur.defaultModel === modelId ? (models[0]?.id ?? null) : cur.defaultModel;
      return { ...prev, [agentId]: { ...cur, models, defaultModel } };
    });
  };

  const save = async (id: string) => {
    const edit = edits[id];
    if (!edit) return;
    setError(null);
    setSaved(null);
    setBusyId(id);
    try {
      await api.saveExecutorConfig(id, {
        models: edit.models,
        defaultModel: edit.defaultModel,
        enabled: edit.enabled,
      });
      setSaved(`${id} 配置已保存`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  // Flip the enable/disable toggle and persist it immediately. The config
  // is built explicitly from the current edit state (no pending setState),
  // and the list marker + detail update from the saved response — other
  // agents' unsaved edits are left alone (no full reload).
  const toggleEnabled = async (id: string) => {
    const edit = edits[id];
    const ex = executors.find((e) => e.id === id);
    if (!edit || !ex?.config) return;
    const next = { models: edit.models, defaultModel: edit.defaultModel, enabled: !edit.enabled };
    setError(null);
    setSaved(null);
    setBusyId(id);
    try {
      const r = await api.saveExecutorConfig(id, next);
      setExecutors((prev) =>
        prev.map((e) => (e.id === id && e.config ? { ...e, config: r.config } : e)),
      );
      setEdits((prev) => ({
        ...prev,
        [id]: { models: r.config.models, defaultModel: r.config.defaultModel, enabled: r.config.enabled },
      }));
      setSaved(`${id} 已${r.config.enabled ? '启用' : '禁用'}`);
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

  const selected = executors.find((e) => e.id === selectedId) ?? null;
  const selectedEdit = selected
    ? (edits[selected.id] ?? { models: [], defaultModel: null, enabled: true })
    : null;
  const selectedModels = selected ? modelsState[selected.id] : undefined;
  // Fetched models not yet added — the pool the bottom dropdown draws from.
  const unaddedModels =
    selectedModels?.status === 'ready' && selectedEdit
      ? selectedModels.models.filter((m) => !selectedEdit.models.some((cm) => cm.id === m))
      : [];

  const scopeLine = (edit: {
    models: ConfigModel[];
    defaultModel: string | null;
    enabled: boolean;
  }): string => {
    if (edit.models.length === 0) return '未添加任何模型，该 agent 不会参与派发。';
    const parts = edit.models.map(
      (m) =>
        `${m.id}（${REASONING_LABELS[m.reasoning]} · ${m.context}${m.id === edit.defaultModel ? '，默认' : ''}）`,
    );
    const line = `派发时仅使用：${parts.join('、')}`;
    return edit.enabled ? line : `${line}（已禁用，不参与派发）`;
  };

  return (
    <div>
      <h1>设置</h1>
      <p className="sub">主脑、执行者、隧道——以及各执行者应使用的模型。</p>
      {error && <p className="error">{error}</p>}
      {saved && <p style={{ color: 'var(--green)' }}>{saved}</p>}
      <div className="tabs">
        <button className={`tab${tab === 'brain' ? ' active' : ''}`} onClick={() => setTab('brain')}>
          主脑
        </button>
        <button
          className={`tab${tab === 'executors' ? ' active' : ''}`}
          onClick={() => setTab('executors')}
        >
          执行者
        </button>
        <button
          className={`tab${tab === 'tunnel' ? ' active' : ''}`}
          onClick={() => setTab('tunnel')}
        >
          隧道
        </button>
      </div>

      {tab === 'brain' && (
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
      )}

      {tab === 'executors' && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(280px, 340px) minmax(0, 1fr)',
            gap: 16,
            alignItems: 'start',
          }}
        >
          <div className="card" style={{ marginBottom: 0, minWidth: 0 }}>
            <h2>本地 Agent</h2>
            {executors.length === 0 ? (
              <p className="sub">加载中…</p>
            ) : (
              <div>
                {executors.map((e) => (
                  <div
                    key={e.id}
                    onClick={() => selectExecutor(e.id)}
                    style={{
                      padding: '8px 12px',
                      borderRadius: 8,
                      cursor: 'pointer',
                      background:
                        e.id === selectedId ? 'var(--accent-bg)' : 'transparent',
                      border:
                        e.id === selectedId
                          ? '1px solid var(--accent)'
                          : '1px solid transparent',
                      marginBottom: 4,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      <span
                        style={{
                          display: 'flex',
                          gap: 6,
                          alignItems: 'baseline',
                          minWidth: 0,
                        }}
                      >
                        <strong>{e.label}</strong>
                        {e.version && (
                          <span
                            className="sub"
                            style={{
                              margin: 0,
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {e.version}
                          </span>
                        )}
                      </span>
                      <span style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 'none' }}>
                        {e.config?.enabled ? (
                          <span className="sub" style={{ margin: 0, lineHeight: 1.5 }}>
                            已启用
                          </span>
                        ) : e.added ? (
                          <span className="sub" style={{ margin: 0, lineHeight: 1.5 }}>
                            已配置
                          </span>
                        ) : null}
                        <span className={`pill ${e.detected ? 'connected' : 'missing'}`}>
                          {e.detected ? '已检测到' : '未检测到'}
                        </span>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card" style={{ marginBottom: 0, minWidth: 0 }}>
            {selected === null || selectedEdit === null ? (
              <p className="sub">没有可配置的 agent。</p>
            ) : (
              <>
                <div
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}
                >
                  <div>
                    <h2 style={{ marginBottom: 6 }}>
                      {selected.label}{' '}
                      <span className={`pill ${selected.detected ? 'connected' : 'missing'}`}>
                        {selected.detected ? '已检测到' : '未检测到'}
                      </span>
                    </h2>
                    {selected.detected && selected.signal && (
                      <p className="sub" style={{ margin: '0 0 4px', overflowWrap: 'break-word' }}>
                        {selected.signal.kind === 'binary'
                          ? `二进制 ${selected.signal.value}`
                          : `配置目录 ${selected.signal.value}`}
                      </p>
                    )}
                  </div>
                  {selected.added && (
                    <button
                      className="btn secondary"
                      disabled={busyId === selected.id}
                      onClick={() => void toggleEnabled(selected.id)}
                    >
                      {selectedEdit.enabled ? '禁用' : '启用'}
                    </button>
                  )}
                </div>

                {!selected.detected && (
                  <div>
                    <p className="error">{selected.reason}</p>
                    <button
                      className="btn secondary"
                      onClick={() => loadExecutors(true)}
                    >
                      重新检测
                    </button>
                  </div>
                )}

                {!selected.dispatchable && (
                  <p className="sub">
                    该 agent 的派发尚未接入：可检测、可配置模型，但主脑暂时无法向它派发任务。
                  </p>
                )}

                {selected.detected && (
                  <>
                    {selectedModels === undefined || selectedModels.status === 'loading' ? (
                      <p className="sub">加载模型中…</p>
                    ) : selectedModels.status === 'error' ? (
                      <div>
                        <p className="error">模型列表获取失败</p>
                        <p className="sub">{selectedModels.error}</p>
                        <button
                          className="btn secondary"
                          onClick={() => fetchModels(selected.id, true)}
                        >
                          重试
                        </button>
                      </div>
                    ) : (
                      <>
                        <h3 style={{ margin: '18px 0 8px' }}>模型与派发范围</h3>
                        <p className="sub" style={{ marginTop: 0, overflowWrap: 'break-word' }}>
                          来源：{selectedModels.source}
                        </p>
                        {selectedEdit.models.length === 0 ? (
                          <p className="sub">尚未添加模型，从下方下拉框选择添加。</p>
                        ) : (
                          <table>
                            <thead>
                              <tr>
                                <th>模型</th>
                                <th>推理等级</th>
                                <th>上下文</th>
                                <th>默认</th>
                                <th></th>
                              </tr>
                            </thead>
                            <tbody>
                              {selectedEdit.models.map((m) => (
                                <tr key={m.id}>
                                  <td style={{ wordBreak: 'break-all' }}>
                                    <strong>{m.id}</strong>
                                  </td>
                                  <td>
                                    <select
                                      value={m.reasoning}
                                      onChange={(ev) =>
                                        updateModel(selected.id, m.id, {
                                          reasoning: ev.target.value as ConfigModel['reasoning'],
                                        })
                                      }
                                    >
                                      {(['low', 'medium', 'high'] as const).map((l) => (
                                        <option key={l} value={l}>
                                          {REASONING_LABELS[l]}
                                        </option>
                                      ))}
                                    </select>
                                  </td>
                                  <td>
                                    <select
                                      value={m.context}
                                      onChange={(ev) =>
                                        updateModel(selected.id, m.id, { context: ev.target.value })
                                      }
                                    >
                                      {CONTEXT_OPTIONS.map((c) => (
                                        <option key={c} value={c}>
                                          {c}
                                        </option>
                                      ))}
                                    </select>
                                  </td>
                                  <td>
                                    <input
                                      type="radio"
                                      name={`default-${selected.id}`}
                                      checked={selectedEdit.defaultModel === m.id}
                                      onChange={() =>
                                        setEdits((prev) => ({
                                          ...prev,
                                          [selected.id]: { ...selectedEdit, defaultModel: m.id },
                                        }))
                                      }
                                    />
                                  </td>
                                  <td style={{ textAlign: 'right' }}>
                                    <button
                                      className="btn secondary"
                                      onClick={() => removeModel(selected.id, m.id)}
                                    >
                                      删除
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        <p className="sub" style={{ marginTop: 16, overflowWrap: 'break-word' }}>
                          {scopeLine(selectedEdit)}
                        </p>
                        <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
                          <select
                            value={dropdownModel}
                            disabled={unaddedModels.length === 0}
                            onChange={(ev) => setDropdownModel(ev.target.value)}
                            style={{ flex: 1, minWidth: 0 }}
                          >
                            {unaddedModels.length === 0 ? (
                              <option value="">该 agent 的模型已全部添加。</option>
                            ) : (
                              <>
                                <option value="">选择要添加的模型…</option>
                                {unaddedModels.map((m) => (
                                  <option key={m} value={m}>
                                    {m}
                                  </option>
                                ))}
                              </>
                            )}
                          </select>
                          <button
                            className="btn secondary"
                            disabled={
                              dropdownModel === '' || !unaddedModels.includes(dropdownModel)
                            }
                            onClick={() => {
                              if (dropdownModel === '') return;
                              addModel(selected.id, dropdownModel);
                              setDropdownModel('');
                            }}
                          >
                            添加
                          </button>
                        </div>
                        <button
                          className="btn"
                          style={{ width: '100%' }}
                          disabled={busyId === selected.id}
                          onClick={() => void save(selected.id)}
                        >
                          {busyId === selected.id ? '保存中…' : '保存配置'}
                        </button>
                      </>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'tunnel' && (
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
      )}
    </div>
  );
}
