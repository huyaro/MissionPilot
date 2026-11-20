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
    const http = new HttpMcpServer(store, dispatcher, { port, token, readOnly });
    const actualPort = await http.listen();
    scheduler.start(tick);

    let tunnel: TunnelManager | null = null;
    const tunnelId = process.env.ORCHESTRATOR_TUNNEL_ID;
    if (tunnelId) {
      const apiKey = process.env.ORCHESTRATOR_TUNNEL_API_KEY;
      if (!apiKey) {
        log('warn', 'ORCHESTRATOR_TUNNEL_ID is set but ORCHESTRATOR_TUNNEL_API_KEY is missing; tunnel not started');
      } else {
        tunnel = new TunnelManager({
          tunnelId,
          apiKey,
          mcpServerUrl: `http://127.0.0.1:${actualPort}/mcp`,
          dataDir,
          bin: process.env.ORCHESTRATOR_TUNNEL_BIN,
        });
        tunnel.start();
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
