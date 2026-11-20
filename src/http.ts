// Streamable HTTP MCP transport (P2): the same tool definitions as stdio,
// served over HTTP on 127.0.0.1 so the official tunnel-client can forward
// ChatGPT to it. Binds localhost only — remote access comes only through
// the tunnel, never a public port.
// Auth: bearer token (ORCHESTRATOR_MCP_TOKEN), required; missing or wrong
// token -> 401. Bodies are capped at 10 MiB (the tunnel's per-request cap).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Store } from './store.js';
import type { Dispatcher } from './dispatcher.js';
import { createMcpServer } from './mcp.js';
import { log } from './log.js';

const MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface HttpMcpServerOptions {
  port: number;
  host?: string;
  /** Bearer token; the server refuses to start without one. */
  token: string;
  /** P2a read-only mode. */
  readOnly?: boolean;
  /** P3 board API handler (REST + SSE) for /api/* paths; same bearer auth. */
  board?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
}

export class HttpMcpServer {
  private store: Store;
  private dispatcher: Dispatcher;
  private port: number;
  private host: string;
  private token: string;
  private readOnly: boolean;
  private board?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private transports = new Map<string, StreamableHTTPServerTransport>();

  constructor(store: Store, dispatcher: Dispatcher, opts: HttpMcpServerOptions) {
    if (!opts.token) throw new Error('HTTP mode needs ORCHESTRATOR_MCP_TOKEN (bearer token)');
    this.store = store;
    this.dispatcher = dispatcher;
    this.port = opts.port;
    this.host = opts.host ?? '127.0.0.1';
    this.token = opts.token;
    this.readOnly = opts.readOnly ?? false;
    this.board = opts.board;
  }

  get mode(): 'full' | 'readonly' {
    return this.readOnly ? 'readonly' : 'full';
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.httpServer = createServer((req, res) => {
        void this.handle(req, res).catch((err: unknown) => {
          log('error', 'http handler failed', { error: err instanceof Error ? err.message : String(err) });
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal error' }));
          }
        });
      });
      this.httpServer.on('error', reject);
      this.httpServer.listen(this.port, this.host, () => {
        const addr = this.httpServer?.address();
        const actualPort = typeof addr === 'object' && addr !== null ? addr.port : this.port;
        log('info', 'HTTP MCP server listening', { host: this.host, port: actualPort, mode: this.mode });
        resolve(actualPort);
      });
    });
  }

  async close(): Promise<void> {
    for (const transport of this.transports.values()) {
      await transport.close().catch(() => undefined);
    }
    this.transports.clear();
    await new Promise<void>((resolve) => {
      if (!this.httpServer) return resolve();
      this.httpServer.close(() => resolve());
    });
  }

  private checkAuth(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? '';
    const prefix = 'Bearer ';
    if (header.startsWith(prefix)) {
      const given = Buffer.from(header.slice(prefix.length));
      const expected = Buffer.from(this.token);
      if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
    }
    // SSE (EventSource) cannot send an Authorization header, so /api/events
    // also accepts the token as a query parameter. Localhost only; the
    // server never logs request URLs.
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/api/events' && req.method === 'GET') {
      const given = Buffer.from(url.searchParams.get('token') ?? '');
      const expected = Buffer.from(this.token);
      return given.length === expected.length && timingSafeEqual(given, expected);
    }
    return false;
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > MAX_BODY_BYTES) throw new Error('request body too large (max 10 MiB)');
      chunks.push(buf);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (text === '') return undefined;
    return JSON.parse(text) as unknown;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mode: this.mode, sessions: this.transports.size }));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      // CORS: the board frontend runs in the Tauri webview (tauri://
      // origin in the packaged app, localhost:1420 in dev), so browser
      // fetches to this API are cross-origin. The server is localhost-only
      // and every /api/* call still needs the bearer token — CORS only lets
      // the browser read the response, it does not bypass auth.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'authorization, content-type, mcp-session-id',
      );
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (!this.checkAuth(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      if (this.board && (await this.board(req, res))) return;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    if (!this.checkAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (req.method === 'POST') {
      const body = await this.readBody(req);
      const sessionId = req.headers['mcp-session-id'];
      const sessionKey = Array.isArray(sessionId) ? sessionId[0] : sessionId;
      let transport = sessionKey ? this.transports.get(sessionKey) : undefined;
      if (!transport) {
        if (!isInitializeRequest(body)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'missing or unknown mcp-session-id; send initialize first' }));
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            this.transports.set(id, transport as StreamableHTTPServerTransport);
          },
        });
        transport.onclose = () => {
          if (transport?.sessionId) this.transports.delete(transport.sessionId);
        };
        const mcpServer = createMcpServer(this.store, this.dispatcher, { readOnly: this.readOnly });
        await mcpServer.connect(transport);
      }
      await transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      const sessionId = req.headers['mcp-session-id'];
      const sessionKey = Array.isArray(sessionId) ? sessionId[0] : sessionId;
      const transport = sessionKey ? this.transports.get(sessionKey) : undefined;
      if (!transport) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unknown session' }));
        return;
      }
      if (req.method === 'DELETE') {
        await transport.close();
        this.transports.delete(transport.sessionId ?? '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
  }
}
