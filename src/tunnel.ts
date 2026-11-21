// tunnel-client process manager (P2).
//
// Grounded in the official tunnel-client docs (github.com/openai/tunnel-client,
// read 2026-11-20): `tunnel-client run` connects a localhost MCP server to
// ChatGPT through the OpenAI-hosted tunnel. It needs a control-plane API key
// (Tunnels Read + Use) and a tunnel ID, and a `main` MCP channel binding.
// We run it as:
//
//   tunnel-client run --mcp.server-url http://127.0.0.1:<port>/mcp \
//     --control-plane.tunnel-id <tunnel_id> \
//     --health.listen-addr 127.0.0.1:0 --health.url-file <dataDir>/tunnel-health.url
//
// with CONTROL_PLANE_API_KEY / CONTROL_PLANE_TUNNEL_ID in its environment.
// Install on macOS: `brew install openai/tools/tunnel-client`.
// The tunnel ID + restricted key are created once in Platform; the
// orchestrator only runs the daemon and reports its state (it never
// creates tunnels or keys itself).
//
// Health: tunnel-client writes its health URL to the url-file; the manager
// polls it (/healthz). Process-alive alone is not "connected".
// INV-4: the API key is never logged and never stored in SQLite; the
// child's raw output is drained but not logged.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from './log.js';

export type TunnelState = 'stopped' | 'starting' | 'running' | 'reconnecting' | 'failed';

export interface TunnelStatus {
  state: TunnelState;
  tunnelId: string;
  pid: number | null;
  restarts: number;
  healthUrl: string | null;
  lastError: string | null;
}

export interface TunnelOptions {
  bin?: string;
  tunnelId: string;
  /** Control-plane API key (Tunnels Read + Use). Never logged, never stored. */
  apiKey: string;
  /** Local MCP URL the tunnel forwards to, e.g. http://127.0.0.1:8788/mcp. */
  mcpServerUrl: string;
  dataDir: string;
  healthCheckIntervalMs?: number;
  maxRestarts?: number;
}

export class TunnelManager {
  private opts: TunnelOptions;
  private child: ChildProcess | null = null;
  private state: TunnelState = 'stopped';
  private restarts = 0;
  private lastError: string | null = null;
  private healthUrl: string | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private spawnFailed = false;
  private healthUrlFile: string;

  constructor(opts: TunnelOptions) {
    if (!opts.tunnelId) throw new Error('tunnel needs a tunnel id (ORCHESTRATOR_TUNNEL_ID)');
    if (!opts.apiKey) throw new Error('tunnel needs an API key (ORCHESTRATOR_TUNNEL_API_KEY)');
    this.opts = opts;
    this.healthUrlFile = join(opts.dataDir, 'tunnel-health.url');
  }

  start(): void {
    if (this.state === 'running' || this.state === 'starting' || this.state === 'reconnecting') return;
    this.stopping = false;
    this.spawn();
    const interval = this.opts.healthCheckIntervalMs ?? 5_000;
    this.healthTimer = setInterval(() => {
      void this.checkHealth();
    }, interval);
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
    this.state = 'stopped';
  }

  status(): TunnelStatus {
    return {
      state: this.state,
      tunnelId: this.opts.tunnelId,
      pid: this.child?.pid ?? null,
      restarts: this.restarts,
      healthUrl: this.healthUrl,
      lastError: this.lastError,
    };
  }

  private spawn(): void {
    const bin = this.opts.bin ?? 'tunnel-client';
    const args = [
      'run',
      '--mcp.server-url',
      this.opts.mcpServerUrl,
      '--control-plane.tunnel-id',
      this.opts.tunnelId,
      '--health.listen-addr',
      '127.0.0.1:0',
      '--health.url-file',
      this.healthUrlFile,
    ];
    this.spawnFailed = false;
    this.state = this.restarts === 0 ? 'starting' : 'reconnecting';
    const child = spawn(bin, args, {
      env: {
        ...process.env,
        CONTROL_PLANE_API_KEY: this.opts.apiKey,
        CONTROL_PLANE_TUNNEL_ID: this.opts.tunnelId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    // Drain output without logging it (INV-4: it may carry secrets).
    child.stdout?.on('data', () => undefined);
    child.stderr?.on('data', () => undefined);
    child.on('error', (err: Error) => {
      this.spawnFailed = true;
      this.lastError = `failed to spawn ${bin}: ${err.message}`;
      this.state = 'failed';
      log('error', 'tunnel-client spawn failed', { error: err.message });
    });
    child.on('close', (code: number | null, signal: string | null) => {
      this.child = null;
      if (this.stopping) {
        this.state = 'stopped';
        return;
      }
      if (this.spawnFailed) return; // already 'failed'
      this.lastError = `tunnel-client exited (code=${code} signal=${signal})`;
      log('warn', 'tunnel-client exited unexpectedly', { code, signal });
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    const maxRestarts = this.opts.maxRestarts ?? 10;
    if (this.restarts >= maxRestarts) {
      this.state = 'failed';
      log('error', 'tunnel-client gave up after max restarts', { restarts: this.restarts });
      return;
    }
    this.restarts++;
    this.state = 'reconnecting';
    const delay = Math.min(1000 * 2 ** (this.restarts - 1), 30_000);
    this.restartTimer = setTimeout(() => this.spawn(), delay);
  }

  /**
   * Wait until the tunnel reports healthy via /healthz (or give up).
   * Returns false promptly when the process failed to spawn or exited
   * for good; true only when a /healthz fetch succeeds. Used by the
   * Settings UI connection test so it does not wait for the 5s
   * background health timer.
   */
  async waitForHealthy(timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = this.state;
      if (state === 'running') return true;
      if (state === 'failed' || state === 'stopped') return false;
      if (await this.checkHealthOnce()) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  private async checkHealth(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'failed') return;
    await this.checkHealthOnce();
  }

  /** One health probe; returns true when /healthz answers. Updates healthUrl. */
  private async checkHealthOnce(): Promise<boolean> {
    try {
      const url = (await readFile(this.healthUrlFile, 'utf8')).trim();
      if (!url) return false;
      this.healthUrl = url;
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok && (this.state === 'starting' || this.state === 'reconnecting')) {
        this.state = 'running';
        log('info', 'tunnel-client healthy', { tunnelId: this.opts.tunnelId });
      }
      return res.ok;
    } catch {
      // Not ready yet — stay in starting/reconnecting.
      return false;
    }
  }
}
