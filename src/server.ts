// MCP server entry (P0: stdio only). Exposes exactly two tools:
// dispatch_task + get_attempt. Stdout is the MCP channel — all logging
// goes to stderr (see log.ts).
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Store, resolveDataDir, resolveDbPath } from './store.js';
import { Dispatcher, recoverInterruptedAttempts } from './dispatcher.js';
import { codebuddyAdapter } from './adapters/codebuddy.js';
import {
  DISPATCH_TASK_SCHEMA,
  GET_ATTEMPT_SCHEMA,
  handleDispatchTask,
  handleGetAttempt,
} from './tools.js';
import { log } from './log.js';

type JsonSchema = { type: 'object'; properties?: Record<string, object>; required?: string[] };

function asJsonSchema(s: unknown): JsonSchema {
  return s as JsonSchema;
}

export function createMcpServer(store: Store, dispatcher: Dispatcher): Server {
  const server = new Server(
    { name: 'local-agents', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'dispatch_task',
        description:
          'Dispatch a task to a local agent CLI (codebuddy). Async: returns an attempt_id immediately; poll get_attempt for the result.',
        inputSchema: asJsonSchema(DISPATCH_TASK_SCHEMA),
      },
      {
        name: 'get_attempt',
        description: 'Poll an attempt: status, exit code, stderr, events, diff summary.',
        inputSchema: asJsonSchema(GET_ATTEMPT_SCHEMA),
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    let result;
    if (name === 'dispatch_task') {
      result = await handleDispatchTask(dispatcher, args);
    } else if (name === 'get_attempt') {
      result = await handleGetAttempt(store, args);
    } else {
      result = { isError: true, text: `unknown tool: ${name}` };
    }
    return { content: [{ type: 'text', text: result.text }], isError: result.isError };
  });

  return server;
}

async function main(): Promise<void> {
  const dataDir = resolveDataDir();
  const store = new Store(resolveDbPath(dataDir));
  const recovered = recoverInterruptedAttempts(store);
  const dispatcher = new Dispatcher(
    store,
    new Map([['codebuddy', codebuddyAdapter]]),
    dataDir,
  );
  const server = createMcpServer(store, dispatcher);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('info', 'local-agents MCP server started (stdio)', { dataDir, recovered });
  const shutdown = (): void => {
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
