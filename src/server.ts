// MCP server entry.
// - stdio (default): Codex local use.
// - HTTP (--http or ORCHESTRATOR_TRANSPORT=http): Streamable HTTP on
//   127.0.0.1 for ChatGPT via tunnel-client; bearer auth required.
//   With ORCHESTRATOR_TUNNEL_ID set, tunnel-client is managed alongside.
// Stdout is the MCP channel in stdio mode — all logging goes to stderr (see log.ts).
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Store, resolveDataDir, resolveDbPath } from './store.js';
import { Dispatcher, recoverInterruptedAttempts } from './dispatcher.js';
import { Scheduler } from './scheduler.js';
import { Verifier } from './verifier.js';
import { HttpMcpServer } from './http.js';
import { createBoardHandler, type TunnelTestResult } from './board.js';
import { TunnelManager } from './tunnel.js';
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
    // Settings UI path: apply the new values, (re)start tunnel-client,
    // and wait briefly for it to come up so the status area can show
    // the settled state (running, or failed with a reason).
    const applyTunnelConfig = async (
      tunnelId: string,
      apiKey: string,
    ): Promise<ReturnType<TunnelManager['status']>> => {
      const mgr = startTunnel(tunnelId, apiKey);
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
        tunnelId: tunnel?.status().tunnelId ?? process.env.ORCHESTRATOR_TUNNEL_ID ?? null,
        apiKeySet: tunnel !== null || Boolean(process.env.ORCHESTRATOR_TUNNEL_API_KEY),
      }),
      startTunnel: applyTunnelConfig,
      testTunnel: testTunnelChannel,
    });
    const http = new HttpMcpServer(store, dispatcher, { port, token, readOnly, board });
    actualPort = await http.listen();
    scheduler.start(tick);

    const tunnelId = process.env.ORCHESTRATOR_TUNNEL_ID;
    if (tunnelId) {
      const apiKey = process.env.ORCHESTRATOR_TUNNEL_API_KEY;
      if (!apiKey) {
        log('warn', 'ORCHESTRATOR_TUNNEL_ID is set but ORCHESTRATOR_TUNNEL_API_KEY is missing; tunnel not started');
      } else {
        startTunnel(tunnelId, apiKey);
      }
    }
    log('info', 'local-agents MCP server started (http)', {
      dataDir,
      recovered,
      tickMs: tick,
      port: actualPort,
      readOnly,
      tunnel: tunnel ? tunnelId : null,
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
