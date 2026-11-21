import { useEffect, useState } from 'react';
import type { AgentScore, BoardApi } from '../api';

export function Scoreboard(props: { api: BoardApi }) {
  const { api } = props;
  const [agents, setAgents] = useState<AgentScore[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .scoreboard()
      .then((r) => {
        if (!alive) return;
        setAgents(r.agents);
        setGeneratedAt(r.generatedAt);
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [api]);

  return (
    <div>
      <h1>记分板</h1>
      <p className="sub">
        Elo 初始 1200（K=32）。一次通过的尝试会击败同一任务上的失败尝试；单执行者任务没有对手，不改变 Elo。
        {generatedAt ? ` 生成于 ${new Date(generatedAt).toLocaleString()}。` : ''}
      </p>
      {error && <p className="error">{error}</p>}
      <div className="card">
        {agents.length === 0 ? (
          <p className="sub">暂无尝试——首个已验证任务完成后显示分数。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>执行者</th>
                <th>Elo</th>
                <th>成功率</th>
                <th>尝试次数</th>
                <th>通过 / 失败</th>
                <th>平均轮次 / 任务</th>
                <th>Token（输入 / 输出）</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.agent}>
                  <td>
                    <strong>{a.agent}</strong>
                  </td>
                  <td>{a.elo}</td>
                  <td>{a.successRate === null ? '—' : `${Math.round(a.successRate * 100)}%`}</td>
                  <td>{a.attempts}</td>
                  <td>
                    {a.passed} / {a.failed}
                  </td>
                  <td>{a.avgAttemptsPerTask === null ? '—' : a.avgAttemptsPerTask.toFixed(1)}</td>
                  <td>
                    {a.inputTokens === null && a.outputTokens === null
                      ? '—'
                      : `${a.inputTokens ?? 0} / ${a.outputTokens ?? 0}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
