// MCP tool wiring shared by both transports (stdio for Codex, Streamable
// HTTP for ChatGPT via tunnel). One tool definition, two transports.
// Read-only mode (P2a): write tools are listed but rejected with an
// explicit reason; read tools keep working.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Store } from './store.js';
import type { Dispatcher } from './dispatcher.js';
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
import { repoMap, readRepoFile, searchCode } from './repo.js';
import type { ToolResult } from './tools.js';

export interface McpServerOptions {
  /** P2a read-only: dispatch/create/submit are rejected, reads stay open. */
  readOnly?: boolean;
}

const WRITE_TOOLS = new Set(['dispatch_task', 'create_mission', 'submit_plan']);

const REPO_MAP_SCHEMA = {
  type: 'object',
  properties: {
    repo: { type: 'string', description: 'Absolute path of the git repo to look at.' },
  },
  required: ['repo'],
} as const;

const READ_FILE_SCHEMA = {
  type: 'object',
  properties: {
    repo: { type: 'string', description: 'Absolute path of the git repo.' },
    path: { type: 'string', description: 'Path inside the repo.' },
  },
  required: ['repo', 'path'],
} as const;

const SEARCH_CODE_SCHEMA = {
  type: 'object',
  properties: {
    repo: { type: 'string', description: 'Absolute path of the git repo.' },
    query: { type: 'string', description: 'Substring to search for.' },
  },
  required: ['repo', 'query'],
} as const;

type JsonSchema = { type: 'object'; properties?: Record<string, object>; required?: string[] };

function asJsonSchema(s: unknown): JsonSchema {
  return s as JsonSchema;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function handleRepoMap(args: unknown): Promise<ToolResult> {
  try {
    if (!isRecord(args) || typeof args.repo !== 'string' || args.repo === '') {
      throw new Error("repo_map: 'repo' is required");
    }
    return { isError: false, text: await repoMap(args.repo) };
  } catch (err) {
    return { isError: true, text: err instanceof Error ? err.message : String(err) };
  }
}

async function handleReadFile(args: unknown): Promise<ToolResult> {
  try {
    if (!isRecord(args) || typeof args.repo !== 'string' || args.repo === '') {
      throw new Error("read_file: 'repo' is required");
    }
    if (typeof args.path !== 'string' || args.path === '') {
      throw new Error("read_file: 'path' is required");
    }
    return { isError: false, text: await readRepoFile(args.repo, args.path) };
  } catch (err) {
    return { isError: true, text: err instanceof Error ? err.message : String(err) };
  }
}

async function handleSearchCode(args: unknown): Promise<ToolResult> {
  try {
    if (!isRecord(args) || typeof args.repo !== 'string' || args.repo === '') {
      throw new Error("search_code: 'repo' is required");
    }
    if (typeof args.query !== 'string' || args.query === '') {
      throw new Error("search_code: 'query' is required");
    }
    const matches = await searchCode(args.repo, args.query);
    return { isError: false, text: JSON.stringify(matches) };
  } catch (err) {
    return { isError: true, text: err instanceof Error ? err.message : String(err) };
  }
}

export function createMcpServer(
  store: Store,
  dispatcher: Dispatcher,
  opts: McpServerOptions = {},
): Server {
  const readOnly = opts.readOnly ?? false;
  const server = new Server(
    { name: 'pilot-tasks', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'dispatch_task',
        description:
          'Dispatch a task to a local agent CLI (codebuddy or qoder). Async: returns an attempt_id immediately; poll get_attempt for the result.',
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
      {
        name: 'repo_map',
        description: 'List the directory tree of a repo (read-only).',
        inputSchema: asJsonSchema(REPO_MAP_SCHEMA),
      },
      {
        name: 'read_file',
        description: 'Read one file inside a repo (read-only, 64 KiB cap).',
        inputSchema: asJsonSchema(READ_FILE_SCHEMA),
      },
      {
        name: 'search_code',
        description: 'Substring-search code in a repo (read-only).',
        inputSchema: asJsonSchema(SEARCH_CODE_SCHEMA),
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    let result: ToolResult;
    if (readOnly && WRITE_TOOLS.has(name)) {
      result = {
        isError: true,
        text:
          `read-only mode (P2a): '${name}' is disabled. ` +
          `This connection can only read (get_attempt, get_mission, repo_map, read_file, search_code). ` +
          `Dispatch needs full mode (P2b, Business/Enterprise/Edu workspace).`,
      };
    } else if (name === 'dispatch_task') {
      result = await handleDispatchTask(dispatcher, args);
    } else if (name === 'get_attempt') {
      result = await handleGetAttempt(store, args);
    } else if (name === 'create_mission') {
      result = await handleCreateMission(store, args);
    } else if (name === 'submit_plan') {
      result = await handleSubmitPlan(store, args);
    } else if (name === 'get_mission') {
      result = await handleGetMission(store, args);
    } else if (name === 'repo_map') {
      result = await handleRepoMap(args);
    } else if (name === 'read_file') {
      result = await handleReadFile(args);
    } else if (name === 'search_code') {
      result = await handleSearchCode(args);
    } else {
      result = { isError: true, text: `unknown tool: ${name}` };
    }
    return { content: [{ type: 'text', text: result.text }], isError: result.isError };
  });

  return server;
}
