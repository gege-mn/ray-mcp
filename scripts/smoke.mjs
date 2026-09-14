#!/usr/bin/env node
// Smoke-tests the built binary (dist/index.js) over real stdio on the current
// Node version: once without an API key and once against a local fake of Ray's
// hosted endpoint. Run `pnpm build` first.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const BIN = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const KEY = 'ck_live_smoke_test_key';

function assert(condition, message) {
  if (!condition) throw new Error(`smoke: ${message}`);
}

/** Starts the binary, sends JSON-RPC lines, resolves with responses by id. */
async function session(env, requests) {
  // SMOKE_NODE runs the binary on another Node version than the fake server.
  const child = spawn(process.env.SMOKE_NODE || process.execPath, [BIN], {
    env: { PATH: process.env.PATH, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const responses = new Map();
  const notifications = [];
  let buffer = '';
  const wanted = requests.filter((r) => r.id !== undefined).length;
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout; stderr:\n${stderr}`)), 15_000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line); // anything non-JSON on stdout is a bug
        if (msg.id !== undefined) responses.set(msg.id, msg);
        else notifications.push(msg);
        if (responses.size === wanted) {
          clearTimeout(timer);
          resolve();
        }
      }
    });
    child.on('exit', (code) => {
      if (responses.size < wanted) reject(new Error(`exited early (${code}); stderr:\n${stderr}`));
    });
  });
  for (const req of requests) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...req })}\n`);
  // Close stdin right away: the server must still answer everything it read.
  child.stdin.end();
  await done;
  const exitCode = await exited;
  return { responses, notifications, stderr, exitCode };
}

const handshake = [
  {
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } },
  },
  { method: 'notifications/initialized' },
  { id: 2, method: 'tools/list' },
];

async function withoutKey() {
  const { responses, stderr, exitCode } = await session({}, [
    ...handshake,
    { id: 3, method: 'tools/call', params: { name: 'send_notification', arguments: {} } },
  ]);
  const init = responses.get(1).result;
  assert(init.serverInfo.name === 'ray', 'serverInfo.name');
  assert(init.instructions.includes('RAY_API_KEY'), 'instructions mention RAY_API_KEY');
  const tools = responses.get(2).result.tools;
  assert(tools.length === 1 && tools[0].name === 'setup_help', 'setup_help listed');
  const call = responses.get(3).result;
  assert(call.isError === true && call.content[0].text.includes('https://ray.gege.mn'), 'missing-key tool error');
  assert(stderr.includes('RAY_API_KEY is not set'), 'stderr log');
  assert(exitCode === 0, `clean exit on stdin close (got ${exitCode})`);
  console.log('ok - starts without RAY_API_KEY and explains setup');
}

async function withFakeRemote() {
  const authHeaders = [];
  const http = createServer(async (req, res) => {
    authHeaders.push(req.headers.authorization);
    if (req.method !== 'POST') return res.writeHead(405).end();
    if (req.headers.authorization !== `Bearer ${KEY}`) return res.writeHead(401).end('{"error":"unauthorized"}');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const server = new Server(
      { name: 'ray', title: 'Ray notifications', version: '1.2.3' },
      { capabilities: { tools: {} }, instructions: 'remote instructions' },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'whoami', description: 'who', inputSchema: { type: 'object', properties: {} } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => ({
      content: [{ type: 'text', text: `called ${r.params.name}` }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => void server.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString()));
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${http.address().port}/mcp`;
  try {
    const { responses, stderr } = await session({ RAY_API_KEY: KEY, RAY_MCP_URL: url }, [
      ...handshake,
      { id: 3, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
    ]);
    const init = responses.get(1).result;
    assert(init.instructions === 'remote instructions', `forwards remote instructions; stderr:\n${stderr}`);
    assert(init.serverInfo.version === '1.2.3', 'forwards remote version');
    assert(responses.get(2).result.tools[0].name === 'whoami', 'mirrors remote tools');
    assert(responses.get(3).result.content[0].text === 'called whoami', 'forwards tool call');
    assert(authHeaders.length > 0 && authHeaders.every((h) => h === `Bearer ${KEY}`), 'sends bearer key');
    console.log('ok - bridges initialize, tools/list and tools/call to the remote');
  } finally {
    http.closeAllConnections?.();
    http.close();
  }
}

await withoutKey();
await withFakeRemote();
console.log(`smoke tests passed (binary on ${process.env.SMOKE_NODE || `node ${process.version}`})`);
