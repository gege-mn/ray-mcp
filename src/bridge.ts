import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolRequest,
  type CallToolResult,
  type Implementation,
  type ListToolsRequest,
  type ListToolsResult,
  type ServerNotification,
  type ServerRequest,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { DASHBOARD_URL, DEFAULT_MCP_URL, validateUrl } from './config.js';
import { MISSING_KEY_MESSAGE, describeRemoteError, isTransientError } from './errors.js';
import { RemoteConnection, type RemoteInfo } from './remote.js';
import { VERSION } from './version.js';

export const SETUP_TOOL_NAME = 'setup_help';

type HandlerExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface BridgeOptions {
  apiKey: string | undefined;
  url?: string;
  fetch?: FetchLike;
  /** Timeout for the initialize handshake with the hosted endpoint (default 10s). */
  connectTimeoutMs?: number;
  /** Timeout for each forwarded request (default 60s). */
  requestTimeoutMs?: number;
  /** Diagnostic logger. The CLI writes to stderr; stdout is reserved for JSON-RPC. */
  log?: (message: string) => void;
}

export interface Bridge {
  server: Server;
  /** Resolves once no tools/list or tools/call request is in flight. */
  idle(): Promise<void>;
  close(): Promise<void>;
}

const FALLBACK_SERVER_INFO: Implementation = { name: 'ray', title: 'Ray notifications', version: VERSION };

const ABOUT_RAY =
  'Ray is a multi-tenant notification delivery API (email, FCM push, Slack, Discord, Telegram and generic webhooks), not the Ray distributed computing framework. Docs: https://ray.gege.mn/llms.txt';

function textResult(text: string, isError: boolean): CallToolResult {
  return { content: [{ type: 'text', text }], isError };
}

function setupTool(problem: string, canRetry: boolean): Tool {
  return {
    name: SETUP_TOOL_NAME,
    title: 'Ray setup help',
    description: `${problem} Call this tool to see how to fix it${canRetry ? ' and to retry the connection' : ''}.`,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  };
}

/**
 * Builds the local MCP server that mirrors Ray's hosted MCP endpoint.
 *
 * When an API key is configured, the hosted endpoint is contacted once up
 * front so the local server can advertise the remote's name, version and
 * instructions in its own initialize result. Stdio messages that arrive in the
 * meantime simply wait in the pipe. If that first contact fails, the bridge
 * still starts and recovers on the next request.
 */
export async function createBridge(options: BridgeOptions): Promise<Bridge> {
  const url = options.url ?? DEFAULT_MCP_URL;
  const log = options.log ?? (() => undefined);

  // A configuration problem that no amount of retrying will fix.
  let configProblem: { summary: string; detail: string } | undefined;
  const urlProblem = validateUrl(url);
  if (!options.apiKey) {
    configProblem = { summary: 'Ray is not configured yet: RAY_API_KEY is not set.', detail: MISSING_KEY_MESSAGE };
  } else if (urlProblem) {
    configProblem = { summary: urlProblem, detail: urlProblem };
  }

  let server: Server | undefined;
  const notifyToolListChanged = () => {
    server?.sendToolListChanged().catch((err: unknown) => log(`could not send tools/list_changed: ${String(err)}`));
  };

  const remote = configProblem
    ? undefined
    : new RemoteConnection({
        url,
        apiKey: options.apiKey!,
        fetch: options.fetch,
        connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
        requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
        onToolListChanged: notifyToolListChanged,
      });

  let remoteInfo: RemoteInfo | undefined;
  if (remote) {
    try {
      remoteInfo = await remote.connect();
      log(`connected to ${url} (${remoteInfo.serverInfo?.name ?? 'unknown'} ${remoteInfo.serverInfo?.version ?? ''})`.trim());
    } catch (err) {
      log(`could not connect to ${url} at startup, will retry on the next request: ${describeRemoteError(err, url)}`);
    }
  } else if (configProblem) {
    log(configProblem.summary);
  }

  const instructions =
    remoteInfo?.instructions ??
    (configProblem
      ? `${ABOUT_RAY}\n\nThis MCP server is not usable yet. ${configProblem.summary} Tell the user how to fix it (call the ${SETUP_TOOL_NAME} tool for exact steps). API keys are created at ${DASHBOARD_URL}.`
      : `${ABOUT_RAY}\n\nTools are loaded from Ray's hosted MCP endpoint. If only the ${SETUP_TOOL_NAME} tool is listed, the endpoint was unreachable; call ${SETUP_TOOL_NAME} to see why and to retry.`);

  server = new Server(
    { ...FALLBACK_SERVER_INFO, ...remoteInfo?.serverInfo },
    { capabilities: { tools: { listChanged: true } }, instructions },
  );

  // In-flight request tracking, so a client that closes stdin right after
  // writing its last request still receives every response.
  let inFlight = 0;
  let idleWaiters: (() => void)[] = [];
  const track = <T>(work: Promise<T>): Promise<T> => {
    inFlight++;
    return work.finally(() => {
      inFlight--;
      if (inFlight === 0) {
        const waiters = idleWaiters;
        idleWaiters = [];
        waiters.forEach((resolve) => resolve());
      }
    });
  };

  // True while the client holds our placeholder list instead of the real one.
  let servingFallback = false;
  let remoteToolNames = new Set<string>();

  const markRemoteHealthy = (toolNames?: string[]) => {
    if (toolNames) remoteToolNames = new Set(toolNames);
    if (servingFallback) {
      servingFallback = false;
      notifyToolListChanged();
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, (request, extra) => track(listTools(request, extra)));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => track(callTool(request, extra)));

  async function listTools(request: ListToolsRequest, extra: HandlerExtra): Promise<ListToolsResult> {
    if (configProblem || !remote) {
      return { tools: [setupTool(configProblem?.summary ?? 'Ray is not configured.', false)] };
    }
    const params = request.params;
    const attempt = () => remote.listTools(params, extra.signal);
    try {
      let result;
      try {
        result = await attempt();
      } catch (err) {
        // Listing is side-effect free, so one immediate retry (on a fresh
        // connection) smooths over idle keep-alive sockets and redeploys.
        if (extra.signal.aborted || !isTransientError(err)) throw err;
        result = await attempt();
      }
      if (!params?.cursor) markRemoteHealthy(result.tools.map((t) => t.name));
      return result;
    } catch (err) {
      const message = describeRemoteError(err, url);
      log(`tools/list failed: ${message}`);
      if (params?.cursor) {
        // Mid-pagination: a placeholder page would corrupt the client's list.
        throw new McpError(ErrorCode.InternalError, message);
      }
      servingFallback = true;
      return { tools: [setupTool(`Ray's tools could not be loaded. ${message}`, true)] };
    }
  }

  async function callTool(request: CallToolRequest, extra: HandlerExtra): Promise<CallToolResult> {
    const { name } = request.params;

    if (configProblem || !remote) {
      return textResult(configProblem?.detail ?? 'Ray is not configured.', true);
    }

    if (name === SETUP_TOOL_NAME && (servingFallback || !remoteToolNames.has(name))) {
      try {
        const result = await remote.listTools(undefined, extra.signal);
        const wasFallback = servingFallback;
        markRemoteHealthy(result.tools.map((t) => t.name));
        return textResult(
          `Ray is connected and configured correctly (${url}). ${result.tools.length} tools are available${
            wasFallback
              ? '. The tool list has changed; if the Ray tools do not appear, reload the MCP server in your client.'
              : '.'
          }`,
          false,
        );
      } catch (err) {
        return textResult(describeRemoteError(err, url), true);
      }
    }

    try {
      const result = await remote.callTool(request.params, extra.signal);
      markRemoteHealthy();
      return result;
    } catch (err) {
      const message = describeRemoteError(err, url);
      log(`tools/call ${name} failed: ${message}`);
      return textResult(message, true);
    }
  }

  return {
    server,
    idle: () => (inFlight === 0 ? Promise.resolve() : new Promise((resolve) => idleWaiters.push(resolve))),
    async close() {
      await remote?.close();
      await server?.close();
    },
  };
}
