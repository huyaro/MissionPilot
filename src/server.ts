// MCP server entry.
// - stdio (default): Codex local use.
// - HTTP (--http or ORCHESTRATOR_TRANSPORT=http): Streamable HTTP on
//   127.0.0.1 for ChatGPT via tunnel-client; bearer auth required.
//   The tunnel is configured only from the Settings UI (tunnel ID +
//   API key held in backend memory); no env-var config for it.
// Stdout is the MCP channel in stdio mode — all logging goes to stderr (see log.ts).
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Store, resolveDataDir, resolveDbPath } from './store.js';
import { Dispatcher, recoverInterruptedAttempts } from './dispatcher.js';
import { Scheduler } from './scheduler.js';
import { Verifier } from './verifier.js';
import { HttpMcpServer } from './http.js';
import { createBoardHandler, type TunnelTestResult } from './board.js';
import { TunnelManager } from './tunnel.js';
import { loadTunnelConfig, saveTunnelConfig, type SavedTunnelConfig } from './tunnel-config.js';
import { codebuddyAdapter } from './adapters/codebuddy.js';
import { qoderAdapter } from './adapters/qoder.js';
import { createMcpServer } from './mcp.js';
import { log } from './log.js';

async function main(): Promise<void> {
  const dataDir = resolveDataDir();
  const store = new Store(resolveDbPath(dataDir));
  const recovered = recoverInterruptedAttempts(store);
  const adapters = new Map([
    ['codebuddy', codebuddyAdapter],
    ['qoder', qoderAdapter],
  ]);
  // P1: the scheduler owns task/mission status (finalizeTasks: false).
  const dispatcher = new Dispatcher(store, adapters, dataDir, { finalizeTasks: false });
  const verifier = new Verifier(store, adapters);
  const scheduler = new Scheduler(store, dispatcher, verifier);
  const tickMs = Number(process.env.ORCHESTRATOR_TICK_MS ?? 5000);
  const tick = Number.isFinite(tickMs) && tickMs > 0 ? tickMs : 5000;

  const transport =
    process.argv.includes('--http') || process.env.ORCHESTRATOR_TRANSPORT === 'http'
      ? 'http'
      : 'stdio';

  if (transport === 'http') {
    const token = process.env.ORCHESTRATOR_MCP_TOKEN;
    if (!token) {
      log('error', 'HTTP mode needs ORCHESTRATOR_MCP_TOKEN (bearer token)');
      process.exit(1);
    }
    const port = Number(process.env.ORCHESTRATOR_HTTP_PORT ?? 8788);
    const readOnly = (process.env.ORCHESTRATOR_MCP_MODE ?? 'full') === 'readonly';
    let tunnel: TunnelManager | null = null;
    // Tunnel config saved from the Settings UI (tunnel-config.json in
    // the data dir). Loaded once at boot; updated whenever the UI
    // applies new values.
    let savedTunnel: SavedTunnelConfig | null = loadTunnelConfig(dataDir);
    // Port actually bound (normally == port; updated after listen).
    let actualPort = port;
    // (Re)start tunnel-client with the given values. The API key lives
    // only in this process's memory: never written to disk, never logged.
    const startTunnel = (tunnelId: string, apiKey: string): TunnelManager => {
      tunnel?.stop();
      tunnel = new TunnelManager({
        tunnelId,
        apiKey,
        mcpServerUrl: `http://127.0.0.1:${actualPort}/mcp`,
        dataDir,
        bin: process.env.ORCHESTRATOR_TUNNEL_BIN,
      });
      tunnel.start();
      return tunnel;
    };
    // Stop tunnel-client and drop the in-memory API key with it.
    const stopTunnel = (): void => {
      tunnel?.stop();
      tunnel = null;
    };
    // Settings UI path: apply the new values, (re)start tunnel-client,
    // and wait briefly for it to come up so the status area can show
    // the settled state (running, or failed with a reason). Empty
    // fields fall back to the saved config — the key is never echoed
    // back, so the UI cannot prefill it. The resolved values are
    // saved to disk (see tunnel-config.ts) so the next start, and
    // the next backend boot, need no re-entry.
    const applyTunnelConfig = async (
      tunnelId: string,
      apiKey: string,
    ): Promise<ReturnType<TunnelManager['status']>> => {
      const finalId = tunnelId || savedTunnel?.tunnelId || '';
      const finalKey = apiKey || savedTunnel?.apiKey || '';
      if (!finalId || !finalKey) throw new Error('请填写 Tunnel ID 与 API key');
      const mgr = startTunnel(finalId, finalKey);
      try {
        saveTunnelConfig(dataDir, { tunnelId: finalId, apiKey: finalKey });
        savedTunnel = { tunnelId: finalId, apiKey: finalKey };
      } catch (err) {
        log('warn', 'failed to save tunnel config', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await mgr.waitForHealthy(10_000);
      return mgr.status();
    };
    // Settings UI path: verify the channel without changing config.
    // Returns null when no tunnel has been started yet.
    const checkMcpReachable = async (): Promise<boolean> => {
      try {
        const res = await fetch(`http://127.0.0.1:${actualPort}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        return res.ok;
      } catch {
        return false;
      }
    };
    const testTunnelChannel = async (): Promise<TunnelTestResult | null> => {
      if (!tunnel) return null;
      const tunnelHealthy = await tunnel.waitForHealthy(30_000);
      const mcpReachable = await checkMcpReachable();
      const message = !tunnelHealthy
        ? '通道未接通：tunnel-client 健康检查未通过。请检查 Tunnel ID 与 API key 是否正确。'
        : !mcpReachable
          ? '通道未完全接通：tunnel-client 已健康，但本地 MCP 端口不可达。'
          : '通道已接通：tunnel-client 健康检查通过，本地 MCP 端口可达。';
      return { status: tunnel.status(), test: { ok: tunnelHealthy && mcpReachable, tunnelHealthy, mcpReachable, message } };
    };
    const board = createBoardHandler({
      store,
      getTunnelStatus: () => tunnel?.status() ?? null,
      getTunnelConfig: () => ({
        tunnelId: tunnel?.status().tunnelId ?? savedTunnel?.tunnelId ?? null,
        apiKeySet: tunnel !== null || savedTunnel !== null,
      }),
      startTunnel: applyTunnelConfig,
      stopTunnel,
      testTunnel: testTunnelChannel,
    });
    const http = new HttpMcpServer(store, dispatcher, { port, token, readOnly, board });
    actualPort = await http.listen();
    scheduler.start(tick);

    // Auto-start the tunnel from the saved config (first entry in the
    // Settings UI persists it). Spawn failures surface as state
    // 'failed' with a reason; they must not crash the boot.
    if (savedTunnel) {
      try {
        startTunnel(savedTunnel.tunnelId, savedTunnel.apiKey);
      } catch (err) {
        log('warn', 'saved tunnel config could not be started', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    log('info', 'local-agents MCP server started (http)', {
      dataDir,
      recovered,
      tickMs: tick,
      port: actualPort,
      readOnly,
    });
    const shutdown = (): void => {
      scheduler.stop();
      tunnel?.stop();
      void http.close().then(() => {
        store.close();
        process.exit(0);
      });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  const server = createMcpServer(store, dispatcher);
  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
  scheduler.start(tick);
  log('info', 'local-agents MCP server started (stdio)', { dataDir, recovered, tickMs: tick });
  const shutdown = (): void => {
    scheduler.stop();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  log('error', 'server failed to start', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
