import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const VALID_KEY = 'ck_live_test_key_0123456789abcdefghij';
export const FAKE_INSTRUCTIONS = 'Fake Ray instructions: call whoami first.';

export interface FakeRemote {
  url: string;
  port: number;
  /** Authorization headers of every HTTP request received. */
  authHeaders: (string | undefined)[];
  /** tools/call params received. */
  calls: { name: string; arguments?: Record<string, unknown> }[];
  /** When set, every POST is answered with this HTTP status and body. */
  forceResponse?: { status: number; body: unknown; headers?: Record<string, string> };
  close(): Promise<void>;
}

function buildMcpServer(remote: FakeRemote): Server {
  const server = new Server(
    { name: 'ray', title: 'Ray notifications', version: '9.9.9' },
    { capabilities: { tools: {} }, instructions: FAKE_INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'whoami',
        description: 'Show the workspace for this key.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
      },
      {
        name: 'send_notification',
        description: 'Send a notification.',
        inputSchema: {
          type: 'object',
          properties: { channelConfigId: { type: 'string' }, recipient: { type: 'object' } },
          required: ['channelConfigId'],
        },
      },
      {
        name: 'get_template',
        description: 'Get a template.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        annotations: { readOnlyHint: true },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    remote.calls.push({ name: request.params.name, arguments: request.params.arguments });
    switch (request.params.name) {
      case 'whoami':
        return {
          content: [{ type: 'text', text: '{"tenant":"acme"}' }],
          structuredContent: { tenant: 'acme' },
        };
      case 'send_notification':
        return { content: [{ type: 'text', text: JSON.stringify({ queued: true, args: request.params.arguments }) }] };
      case 'get_template':
        return { content: [{ type: 'text', text: 'not_found: template tpl_missing does not exist' }], isError: true };
      default:
        return { content: [{ type: 'text', text: `Unknown tool ${request.params.name}` }], isError: true };
    }
  });
  return server;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

/**
 * A stateless Streamable HTTP MCP server with bearer auth, shaped like Ray's
 * hosted endpoint: a fresh server + transport per request, JSON responses,
 * 401 JSON for bad keys, 405 for GET/DELETE.
 */
export async function startFakeRemote(port = 0): Promise<FakeRemote> {
  let http: HttpServer;
  const remote: FakeRemote = {
    url: '',
    port: 0,
    authHeaders: [],
    calls: [],
    close: () =>
      new Promise((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };

  http = createServer(async (req, res) => {
    remote.authHeaders.push(req.headers.authorization);
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' }).end('{"error":"method_not_allowed"}');
      return;
    }
    if (req.headers.authorization !== `Bearer ${VALID_KEY}`) {
      res
        .writeHead(401, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'unauthorized', message: 'invalid api key' }));
      return;
    }
    if (remote.forceResponse) {
      const { status, body, headers } = remote.forceResponse;
      res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
      return;
    }
    const body = await readBody(req);
    const server = buildMcpServer(remote);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });

  await new Promise<void>((resolve) => http.listen(port, '127.0.0.1', resolve));
  remote.port = (http.address() as AddressInfo).port;
  remote.url = `http://127.0.0.1:${remote.port}/mcp`;
  return remote;
}

/** A local port with nothing listening on it. */
export async function unusedPort(): Promise<number> {
  const http = createServer();
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  await new Promise<void>((resolve) => http.close(() => resolve()));
  return port;
}
