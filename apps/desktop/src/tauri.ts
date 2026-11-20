// Tauri bridge for the desktop board.
// - In the packaged app, the Rust side manages the backend process:
//   start_backend spawns `node <backend.js> --http` with a fresh token,
//   get_token returns it, backend_status probes 127.0.0.1:8788.
// - In vite dev (plain browser) these commands do not exist; the helpers
//   degrade to probing /health directly and letting the user paste a token.
import { invoke } from '@tauri-apps/api/core';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function getAppToken(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string | null>('get_token');
  } catch {
    return null;
  }
}

/** Token for a backend the user started themselves (ORCHESTRATOR_MCP_TOKEN
 * in the app's environment). Lets the app connect without pasting. */
export async function getEnvToken(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string | null>('get_env_token');
  } catch {
    return null;
  }
}

/** Path the app would use when the Backend JS field is left blank
 * (explicit path → packaged → dev layout). Null when none resolves. */
export async function resolveBackendPath(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string | null>('resolve_backend_path');
  } catch {
    return null;
  }
}

export async function startBackend(backendJs?: string): Promise<string> {
  return invoke<string>('start_backend', { backendJs: backendJs ?? null });
}

export async function backendStatus(): Promise<{ running: boolean }> {
  if (!isTauri()) {
    try {
      const res = await fetch('http://127.0.0.1:8788/health');
      return { running: res.ok };
    } catch {
      return { running: false };
    }
  }
  try {
    return await invoke<{ running: boolean }>('backend_status');
  } catch {
    return { running: false };
  }
}
