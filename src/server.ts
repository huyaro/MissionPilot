// MCP server entry. P0: stdio only, dispatch_task + get_attempt.
// P1: + create_mission / submit_plan / get_mission, scheduler loop.
// Stdout is the MCP channel — all logging goes to stderr (see log.ts).
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Store, resolveDataDir, resolveDbPath } from './store.js';
import { Dispatcher, recoverInterruptedAttempts } from './dispatcher.js';
import { Scheduler } from './scheduler.js';
import { Verifier } from './verifier.js';
import { codebuddyAdapter } from './adapters/codebuddy.js';
import { qoderAdapter } from './adapters/qoder.js';
import {
  CREATE_MISSION_SCHEMA,
  DISPATCH_TASK_SCHEMA,
  GET_ATTEMPT_SCHEMA,
  GET_MISSION_SCHEMA,
  SUBMIT_PLAN_SCHEMA,
  handleCreateMission,
  handleDispatchTask,
  handleGetAttempt,
  handleGetMission,
  handleSubmitPlan,
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
      {
        name: 'create_mission',
        description: 'Create a mission (a goal + repo) that a plan can be submitted for.',
        inputSchema: asJsonSchema(CREATE_MISSION_SCHEMA),
      },
      {
        name: 'submit_plan',
        description:
          'Submit a task plan for a mission. The backend validates it (no cycles, every task has acceptance, budget fits) and the scheduler executes it.',
        inputSchema: asJsonSchema(SUBMIT_PLAN_SCHEMA),
      },
      {
        name: 'get_mission',
        description: 'Poll a mission: status, tasks, latest attempt per task, replan proposals.',
        inputSchema: asJsonSchema(GET_MISSION_SCHEMA),
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
    } else if (name === 'create_mission') {
      result = await handleCreateMission(store, args);
    } else if (name === 'submit_plan') {
      result = await handleSubmitPlan(store, args);
    } else if (name === 'get_mission') {
      result = await handleGetMission(store, args);
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
