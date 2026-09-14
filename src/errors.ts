import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { DASHBOARD_URL, DEFAULT_MCP_URL } from './config.js';

export const MISSING_KEY_MESSAGE = [
  'Ray is not configured: the RAY_API_KEY environment variable is not set.',
  '',
  'To fix it:',
  `1. Sign in at ${DASHBOARD_URL} and open "API keys". Create a key (it starts with ck_live_). Give it the write scope if the agent should send notifications or change templates and webhooks.`,
  '2. Add it to this MCP server\'s configuration as an environment variable, for example:',
  '   "env": { "RAY_API_KEY": "ck_live_..." }',
  '3. Restart your MCP client (or reload the MCP server) so the new environment is picked up.',
  '',
  `Alternatively, connect to the hosted server directly: ${DEFAULT_MCP_URL} with the header "Authorization: Bearer ck_live_...".`,
  'Setup guide: https://ray.gege.mn/docs/ai-agents',
].join('\n');

/** Errors that mean the cached remote connection should be thrown away. */
export function isConnectionLevelError(err: unknown): boolean {
  if (err instanceof McpError) {
    return err.code === ErrorCode.RequestTimeout || err.code === ErrorCode.ConnectionClosed;
  }
  // Auth, quota and rate-limit answers are per request; the connection is fine.
  if (err instanceof StreamableHTTPError && [401, 402, 403, 429].includes(err.code ?? 0)) return false;
  // Other HTTP errors, fetch/network TypeErrors, anything unexpected.
  return !isAbortError(err);
}

/** Failures worth one immediate retry for side-effect-free requests. */
export function isTransientError(err: unknown): boolean {
  if (err instanceof StreamableHTTPError) return err.code === undefined || err.code >= 500;
  if (err instanceof McpError) return err.code === ErrorCode.ConnectionClosed;
  return !isAbortError(err) && findNetworkCode(err) !== undefined;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

interface ErrorBody {
  code?: string;
  message?: string;
  retryAfterSeconds?: number;
}

/** Pulls `{ error, message, retry_after_seconds }` (or `{ error: { code, message } }`) out of an HTTP error body. */
function parseErrorBody(text: string): ErrorBody {
  const jsonStart = text.indexOf('{');
  if (jsonStart === -1) return text.trim() ? { message: text.trim().slice(0, 300) } : {};
  try {
    const body = JSON.parse(text.slice(jsonStart)) as Record<string, unknown>;
    const out: ErrorBody = {};
    const err = body.error;
    if (typeof err === 'string') out.code = err;
    else if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>;
      if (typeof e.code === 'string') out.code = e.code;
      if (typeof e.message === 'string') out.message = e.message;
    }
    if (typeof body.message === 'string') out.message = body.message;
    const retry = body.retry_after_seconds ?? body.retryAfterSeconds;
    if (typeof retry === 'number') out.retryAfterSeconds = retry;
    return out;
  } catch {
    return { message: text.trim().slice(0, 300) };
  }
}

const NETWORK_CODES: Record<string, string> = {
  ECONNREFUSED: 'connection refused',
  ENOTFOUND: 'host not found',
  EAI_AGAIN: 'DNS lookup failed',
  ETIMEDOUT: 'connection timed out',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  UND_ERR_CONNECT_TIMEOUT: 'connection timed out',
  UND_ERR_SOCKET: 'socket error',
  CERT_HAS_EXPIRED: 'TLS certificate expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed TLS certificate',
  SELF_SIGNED_CERT_IN_CHAIN: 'self-signed TLS certificate in chain (corporate proxy?)',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate could not be verified',
};

/** Walks `cause` / AggregateError chains looking for a Node network error code. */
function findNetworkCode(err: unknown, depth = 0): string | undefined {
  if (!err || typeof err !== 'object' || depth > 5) return undefined;
  const e = err as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof e.code === 'string' && e.code in NETWORK_CODES) return e.code;
  if (Array.isArray(e.errors)) {
    for (const inner of e.errors) {
      const code = findNetworkCode(inner, depth + 1);
      if (code) return code;
    }
  }
  return findNetworkCode(e.cause, depth + 1);
}

function withDetail(summary: string, body: ErrorBody): string {
  const detail = [body.code, body.message].filter(Boolean).join(': ');
  return detail ? `${summary} Server said: ${detail}.` : summary;
}

/**
 * Turns anything thrown while talking to the hosted endpoint into a message an
 * agent can relay to its user. Never includes the API key.
 */
export function describeRemoteError(err: unknown, url: string): string {
  if (err instanceof StreamableHTTPError) {
    const body = parseErrorBody(err.message.replace(/^Streamable HTTP error: /, '').replace(/^Error POSTing to endpoint: /, ''));
    switch (err.code) {
      case 401:
        return withDetail(
          `Ray rejected the API key (HTTP 401). Check that RAY_API_KEY holds a current key: keys are shown only once, and revoked keys stop working immediately. Create a new key at ${DASHBOARD_URL} under "API keys", update the MCP server's env, and restart your MCP client.`,
          body,
        );
      case 402:
        return withDetail(
          `Ray refused the request because the workspace is over its plan quota (HTTP 402). Upgrade or wait for the next billing period at ${DASHBOARD_URL}.`,
          body,
        );
      case 403:
        return withDetail(
          'Ray refused the request (HTTP 403). The API key may lack a required scope: sending and changing templates or webhooks need a key with the write scope.',
          body,
        );
      case 404:
        return url === DEFAULT_MCP_URL
          ? `Ray's hosted MCP endpoint is not available at ${url} (HTTP 404). Try again later, or update @gege-mn/ray-mcp if the endpoint has moved.`
          : `No MCP endpoint was found at ${url} (HTTP 404). Check RAY_MCP_URL, or unset it to use ${DEFAULT_MCP_URL}.`;
      case 429: {
        const wait = body.retryAfterSeconds !== undefined ? ` Retry in about ${body.retryAfterSeconds} seconds.` : ' Wait a moment before retrying.';
        return withDetail(`Ray's rate limit was reached (HTTP 429).${wait}`, body);
      }
      case -1:
        return `The server at ${url} did not answer like an MCP endpoint (${err.message}). Check RAY_MCP_URL.`;
      default:
        if (err.code !== undefined && err.code >= 500) {
          return withDetail(
            `Ray's MCP endpoint had a server error (HTTP ${err.code}). This is usually temporary; try again shortly.`,
            body,
          );
        }
        return withDetail(`Ray's MCP endpoint returned HTTP ${err.code ?? 'error'}.`, body);
    }
  }

  if (err instanceof McpError) {
    if (err.code === ErrorCode.RequestTimeout) {
      return `Timed out waiting for Ray's MCP endpoint at ${url}. The request may still have been processed; check before retrying anything that sends.`;
    }
    if (err.code === ErrorCode.ConnectionClosed) {
      return `The connection to Ray's MCP endpoint at ${url} was closed. Try again.`;
    }
    return `Ray's MCP endpoint returned an error (${err.code}): ${err.message.replace(/^MCP error -?\d+: /, '')}`;
  }

  if (isAbortError(err)) {
    return 'The request to Ray was cancelled.';
  }

  const code = findNetworkCode(err);
  if (code) {
    return `Could not reach Ray's MCP endpoint at ${url} (${code}: ${NETWORK_CODES[code]}). Check your internet connection, proxy or firewall settings, and RAY_MCP_URL.`;
  }
  if (err instanceof TypeError && /fetch failed|network/i.test(err.message)) {
    return `Could not reach Ray's MCP endpoint at ${url} (${err.message}). Check your internet connection, proxy or firewall settings, and RAY_MCP_URL.`;
  }

  const message = err instanceof Error ? err.message : String(err);
  return `Unexpected error talking to Ray's MCP endpoint at ${url}: ${message}`;
}
