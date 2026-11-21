// Persisted tunnel config (Settings UI only).
//
// The user asked for the tunnel ID + API key to be saved on first entry
// so they survive backend restarts — the earlier memory-only design
// forced re-entry every time and left the start button disabled after
// a stop (the key was never echoed back, so the input stayed empty).
// The file lives in the backend data dir (~/.mission-pilot) next to the
// SQLite DB, is created owner-only (0600), and is never logged or
// echoed back in any API response. The backend reads it at boot to
// auto-start the tunnel and uses it when the UI sends empty fields.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SavedTunnelConfig {
  tunnelId: string;
  apiKey: string;
}

export function tunnelConfigPath(dataDir: string): string {
  return join(dataDir, 'tunnel-config.json');
}

/** Returns null when the file is missing, unreadable, or malformed. */
export function loadTunnelConfig(dataDir: string): SavedTunnelConfig | null {
  const path = tunnelConfigPath(dataDir);
  try {
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).tunnelId !== 'string' ||
      typeof (parsed as Record<string, unknown>).apiKey !== 'string' ||
      ((parsed as Record<string, unknown>).tunnelId as string).trim() === '' ||
      ((parsed as Record<string, unknown>).apiKey as string).trim() === ''
    ) {
      return null;
    }
    return {
      tunnelId: (parsed as Record<string, unknown>).tunnelId as string,
      apiKey: (parsed as Record<string, unknown>).apiKey as string,
    };
  } catch {
    return null;
  }
}

/** Overwrites the file (owner-only). Throws on I/O failure. */
export function saveTunnelConfig(dataDir: string, config: SavedTunnelConfig): void {
  mkdirSync(dataDir, { recursive: true });
  const path = tunnelConfigPath(dataDir);
  writeFileSync(path, `${JSON.stringify(config)}\n`, 'utf8');
  chmodSync(path, 0o600);
}
