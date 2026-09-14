import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createBridge, SETUP_TOOL_NAME, type BridgeOptions } from '../src/bridge.js';
import { FAKE_INSTRUCTIONS, startFakeRemote, unusedPort, VALID_KEY, type FakeRemote } from './fake-remote.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => undefined);
});

async function remote(port?: number): Promise<FakeRemote> {
  const fake = await startFakeRemote(port);
  cleanups.push(() => fake.close());
  return fake;
}

async function connect(options: BridgeOptions) {
  const logs: string[] = [];
  const bridge = await createBridge({ connectTimeoutMs: 5_000, requestTimeoutMs: 5_000, log: (m) => logs.push(m), ...options });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  let listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChanged++;
  });
  await bridge.server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await bridge.close();
  });
  return { client, bridge, logs, listChanged: () => listChanged };
}

function text(result: CallToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

async function waitFor(check: () => boolean, ms = 2_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('bridge with a healthy remote', () => {
  it('mirrors the remote tool list, instructions and server info', async () => {
    const fake = await remote();
    const { client } = await connect({ apiKey: VALID_KEY, url: fake.url });

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['whoami', 'send_notification', 'get_template']);
    expect(tools[0]?.annotations?.readOnlyHint).toBe(true);
    expect(tools[1]?.inputSchema.required).toEqual(['channelConfigId']);

    expect(client.getInstructions()).toBe(FAKE_INSTRUCTIONS);
    expect(client.getServerVersion()).toMatchObject({ name: 'ray', title: 'Ray notifications', version: '9.9.9' });
    expect(client.getServerCapabilities()?.tools).toEqual({ listChanged: true });
  });

  it('forwards tool calls with the bearer API key and passes results through', async () => {
    const fake = await remote();
    const { client } = await connect({ apiKey: VALID_KEY, url: fake.url });

    const args = { channelConfigId: 'cc_1', recipient: { email: 'me@example.com' } };
    const result = await call(client, 'send_notification', args);

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toEqual({ queued: true, args });
    expect(fake.calls).toEqual([{ name: 'send_notification', arguments: args }]);
    expect(fake.authHeaders.length).toBeGreaterThan(0);
    expect(fake.authHeaders.every((h) => h === `Bearer ${VALID_KEY}`)).toBe(true);

    const whoami = await call(client, 'whoami');
    expect(whoami.structuredContent).toEqual({ tenant: 'acme' });
  });

  it('passes a remote isError result through unchanged', async () => {
    const fake = await remote();
    const { client } = await connect({ apiKey: VALID_KEY, url: fake.url });

    const result = await call(client, 'get_template', { id: 'tpl_missing' });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('not_found: template tpl_missing does not exist');
  });

  it('maps HTTP 429 to a readable tool error with the retry delay', async () => {
    const fake = await remote();
    const { client } = await connect({ apiKey: VALID_KEY, url: fake.url });
    await client.listTools();

    fake.forceResponse = {
      status: 429,
      body: { error: 'rate_limited', message: 'Too many requests', retry_after_seconds: 12 },
      headers: { 'retry-after': '12' },
    };
    const result = await call(client, 'whoami');
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('rate limit');
    expect(text(result)).toContain('12 seconds');

    fake.forceResponse = undefined;
    expect((await call(client, 'whoami')).isError).toBeFalsy();
  });

  it('turns a 5xx during a call into a tool error and recovers on the next call', async () => {
    const fake = await remote();
    const { client } = await connect({ apiKey: VALID_KEY, url: fake.url });

    fake.forceResponse = { status: 502, body: { error: 'bad_gateway' } };
    const failed = await call(client, 'whoami');
    expect(failed.isError).toBe(true);
    expect(text(failed)).toContain('HTTP 502');

    fake.forceResponse = undefined;
    expect((await call(client, 'whoami')).isError).toBeFalsy();
  });
});

describe('bridge with an invalid API key', () => {
  it('starts, lists setup_help with the 401 explanation, and returns readable tool errors', async () => {
    const fake = await remote();
    const { client, logs } = await connect({ apiKey: 'ck_live_revoked', url: fake.url });

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([SETUP_TOOL_NAME]);
    expect(tools[0]?.description).toContain('HTTP 401');

    const result = await call(client, 'send_notification', { channelConfigId: 'cc_1' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Ray rejected the API key (HTTP 401)');
    expect(text(result)).toContain('https://ray.gege.mn');
    expect(text(result)).toContain('invalid api key');
    expect(text(result)).not.toContain('ck_live_revoked');

    const help = await call(client, SETUP_TOOL_NAME);
    expect(help.isError).toBe(true);
    expect(text(help)).toContain('HTTP 401');

    expect(fake.calls).toEqual([]);
    expect(logs.join('\n')).toContain('HTTP 401');
  });
});

describe('bridge with an unreachable remote', () => {
  it('maps connection refused to a helpful error instead of crashing', async () => {
    const port = await unusedPort();
    const url = `http://127.0.0.1:${port}/mcp`;
    const { client } = await connect({ apiKey: VALID_KEY, url });

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([SETUP_TOOL_NAME]);
    expect(tools[0]?.description).toContain('ECONNREFUSED');

    const result = await call(client, 'whoami');
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(`Could not reach Ray's MCP endpoint at ${url} (ECONNREFUSED`);
    expect(client.getInstructions()).toContain('not the Ray distributed computing framework');
  });

  it('recovers when the remote comes back and announces tools/list_changed', async () => {
    const port = await unusedPort();
    const url = `http://127.0.0.1:${port}/mcp`;
    const { client, listChanged } = await connect({ apiKey: VALID_KEY, url });

    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([SETUP_TOOL_NAME]);

    await remote(port);
    const help = await call(client, SETUP_TOOL_NAME);
    expect(help.isError).toBe(false);
    expect(text(help)).toContain('3 tools are available');

    await waitFor(() => listChanged() === 1);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['whoami', 'send_notification', 'get_template']);
  });
});

describe('bridge without RAY_API_KEY', () => {
  it('starts, lists only setup_help, and every call explains how to create a key', async () => {
    const fake = await remote();
    const { client, logs } = await connect({ apiKey: undefined, url: fake.url });

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe(SETUP_TOOL_NAME);
    expect(tools[0]?.description).toContain('RAY_API_KEY is not set');
    expect(client.getInstructions()).toContain('RAY_API_KEY is not set');
    expect(client.getServerVersion()?.name).toBe('ray');

    for (const name of [SETUP_TOOL_NAME, 'send_notification']) {
      const result = await call(client, name);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('RAY_API_KEY');
      expect(text(result)).toContain('https://ray.gege.mn');
    }

    // No request ever reaches the remote without a key.
    expect(fake.authHeaders).toEqual([]);
    expect(logs.join('\n')).toContain('RAY_API_KEY is not set');
  });

  it('reports an invalid RAY_MCP_URL the same way', async () => {
    const { client } = await connect({ apiKey: VALID_KEY, url: 'not a url' });
    const result = await call(client, 'whoami');
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('RAY_MCP_URL is not a valid URL');
  });
});
