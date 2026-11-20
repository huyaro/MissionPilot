// MCP server entry. P0: stdio only, dispatch_task + get_attempt.
// P1: + create_mission / submit_plan / get_mission, scheduler loop.
// Stdout is the MCP channel — all logging goes to stderr (see log.ts).
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Store, resolveDataDir, resolveDbPath } from './store.js';
import { Dispatcher, recoverInterruptedAttempts } from './dispatcher.js';
import { Scheduler } from './scheduler.js';
import { Verifier } from './verifier.js';
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
  const server = createMcpServer(store, dispatcher);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const tickMs = Number(process.env.ORCHESTRATOR_TICK_MS ?? 5000);
  scheduler.start(Number.isFinite(tickMs) && tickMs > 0 ? tickMs : 5000);
  log('info', 'local-agents MCP server started (stdio)', { dataDir, recovered, tickMs });
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
