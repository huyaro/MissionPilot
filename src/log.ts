// Structured logging. MCP stdio owns stdout — logs go to stderr only,
// one JSON object per line.
export type LogLevel = 'info' | 'warn' | 'error';

export function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  process.stderr.write(line + '\n');
}
