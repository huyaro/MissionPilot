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
      <h1>Scoreboard</h1>
      <p className="sub">
        Elo starts at 1200 (K=32). A passing attempt beats the failed attempts on the same task;
        single-agent tasks have no opponent and do not move Elo.
        {generatedAt ? ` Generated ${new Date(generatedAt).toLocaleString()}.` : ''}
      </p>
      {error && <p className="error">{error}</p>}
      <div className="card">
        {agents.length === 0 ? (
          <p className="sub">No attempts yet — scores appear after the first verified task.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Elo</th>
                <th>Success rate</th>
                <th>Attempts</th>
                <th>Passed / Failed</th>
                <th>Avg rounds / task</th>
                <th>Tokens (in / out)</th>
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
