import { useEffect, useState } from 'react';
import type { BoardApi } from '../api';

export function AttemptDetail(props: { api: BoardApi; attemptId: string }) {
  const { api, attemptId } = props;
  const [data, setData] = useState<Awaited<ReturnType<BoardApi['attemptDetail']>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .attemptDetail(attemptId)
      .then((r) => alive && setData(r))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [api, attemptId]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="sub">Loading attempt…</p>;
  const { attempt, events, worktree, evidence } = data;
  const diff = (() => {
    if (!attempt.diffSummary) return null;
    try {
      return JSON.parse(attempt.diffSummary) as {
        filesChanged: number;
        insertions: number;
        deletions: number;
        files: string[];
      };
    } catch {
      return null;
    }
  })();
  return (
    <div>
      <h1>
        Attempt · {attempt.agent}
      </h1>
      <p className="sub">
        <span className={`pill ${attempt.status}`}>{attempt.status}</span>{' '}
        <span className="mono">{attempt.id}</span>
        {attempt.exitCode !== null ? ` · exit ${attempt.exitCode}` : ''}
        {worktree ? ` · worktree ${worktree.path}` : ''}
      </p>
      <div className="two-col">
        <div className="card">
          <h2>Event stream ({events.length})</h2>
          {events.length === 0 ? (
            <p className="sub">No events recorded yet.</p>
          ) : (
            <div className="event-list">
              {events.map((e) => (
                <div className="event-row" key={e.id}>
                  <span className="ts">{new Date(e.ts).toLocaleTimeString()}</span>
                  <span>
                    <strong>{e.type}</strong>{' '}
                    <span className="mono">{e.payload.slice(0, 200)}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
          {attempt.stderr && (
            <>
              <h2 style={{ marginTop: 16 }}>stderr</h2>
              <pre>{attempt.stderr}</pre>
            </>
          )}
        </div>
        <div>
          <div className="card">
            <h2>Diff</h2>
            {diff ? (
              <>
                <div>
                  {diff.filesChanged} files · +{diff.insertions} / −{diff.deletions}
                </div>
                <pre>{diff.files.join('\n')}</pre>
              </>
            ) : (
              <p className="sub">No diff recorded (empty diff or attempt not finished).</p>
            )}
          </div>
          <div className="card">
            <h2>Verification evidence</h2>
            {evidence === null ? (
              <p className="sub">Not verified yet.</p>
            ) : (
              <pre>{JSON.stringify(evidence, null, 2)}</pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
