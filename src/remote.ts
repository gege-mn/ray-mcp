import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  ToolListChangedNotificationSchema,
  type CallToolRequest,
  type CallToolResult,
  type Implementation,
  type ListToolsRequest,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import { isConnectionLevelError } from './errors.js';
import { PACKAGE_NAME, VERSION } from './version.js';

export interface RemoteOptions {
  url: string;
  apiKey: string;
  /** Custom fetch (tests, proxies). Defaults to global fetch. */
  fetch?: FetchLike;
  /** Timeout for the initialize handshake. */
  connectTimeoutMs?: number;
  /** Timeout for each forwarded request. */
  requestTimeoutMs?: number;
  /** Called when the remote announces that its tool list changed. */
  onToolListChanged?: () => void;
}

export interface RemoteInfo {
  serverInfo: Implementation | undefined;
  instructions: string | undefined;
}

interface Connection {
  client: Client;
  info: RemoteInfo;
}

/**
 * A lazily-initialized, self-healing MCP client for Ray's hosted endpoint.
 *
 * The hosted server is stateless (no Mcp-Session-Id, JSON responses), so a
 * "connection" is only the negotiated protocol version plus server info: every
 * request is an independent authenticated POST. We therefore keep one client
 * around for cheap reuse, and discard it on transport-level failures
 * (network errors, 404/5xx answers, timeouts). The next request re-runs the
 * initialize handshake, which recovers from outages, redeploys, and protocol
 * upgrades without restarting the local process.
 */
export class RemoteConnection {
  private current: Promise<Connection> | undefined;

  constructor(private readonly options: RemoteOptions) {}

  /** Connects if needed and returns the remote's server info and instructions. */
  async connect(): Promise<RemoteInfo> {
    return (await this.getConnection()).info;
  }

  async listTools(params: ListToolsRequest['params'], signal?: AbortSignal): Promise<ListToolsResult> {
    return this.withClient((client) =>
      client.request({ method: 'tools/list', params }, ListToolsResultSchema, {
        signal,
        timeout: this.options.requestTimeoutMs,
      }),
    );
  }

  /**
   * Forwards tools/call verbatim. Uses the raw request rather than
   * `client.callTool` so the bridge never rejects a result because of its own
   * copy of a tool's outputSchema; validation is the downstream client's job.
   */
  async callTool(params: CallToolRequest['params'], signal?: AbortSignal): Promise<CallToolResult> {
    return this.withClient((client) =>
      client.request({ method: 'tools/call', params }, CallToolResultSchema, {
        signal,
        timeout: this.options.requestTimeoutMs,
      }),
    );
  }

  async close(): Promise<void> {
    const pending = this.current;
    this.current = undefined;
    if (!pending) return;
    try {
      await (await pending).client.close();
    } catch {
      // Connection never came up; nothing to close.
    }
  }

  private async withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const connection = this.getConnection();
    const { client } = await connection;
    try {
      return await fn(client);
    } catch (err) {
      if (isConnectionLevelError(err)) this.discard(connection);
      throw err;
    }
  }

  private getConnection(): Promise<Connection> {
    if (!this.current) {
      const attempt = this.open();
      this.current = attempt;
      attempt.catch(() => this.discard(attempt));
    }
    return this.current;
  }

  private discard(connection: Promise<Connection>): void {
    if (this.current !== connection) return;
    this.current = undefined;
    connection.then(({ client }) => client.close()).catch(() => undefined);
  }

  private async open(): Promise<Connection> {
    const { url, apiKey } = this.options;
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      fetch: this.options.fetch,
      requestInit: {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'User-Agent': `${PACKAGE_NAME}/${VERSION} (node ${process.version})`,
        },
      },
    });
    const client = new Client({ name: 'ray-mcp', version: VERSION }, { capabilities: {} });
    // Failed POSTs also reject the pending request, which is where they are
    // reported; logging them here too would only duplicate every message.
    client.onerror = () => undefined;
    // Stateless JSON servers cannot push notifications today, but forward
    // list_changed if the remote ever starts sending it.
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      this.options.onToolListChanged?.();
    });

    await client.connect(transport, { timeout: this.options.connectTimeoutMs });
    return {
      client,
      info: { serverInfo: client.getServerVersion(), instructions: client.getInstructions() },
    };
  }
}
