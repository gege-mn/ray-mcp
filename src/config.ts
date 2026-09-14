export const DEFAULT_MCP_URL = 'https://ray-api.gege.mn/mcp';
export const DASHBOARD_URL = 'https://ray.gege.mn';
export const DOCS_URL = 'https://ray.gege.mn/docs';

export interface BridgeConfig {
  /** Trimmed API key, or undefined when RAY_API_KEY is unset/empty. */
  apiKey: string | undefined;
  /** Hosted MCP endpoint (RAY_MCP_URL or the default). */
  url: string;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  return {
    apiKey: normalizeApiKey(env.RAY_API_KEY),
    url: env.RAY_MCP_URL?.trim() || DEFAULT_MCP_URL,
  };
}

/**
 * Accepts the key as users tend to paste it: surrounding whitespace or quotes
 * and an accidental "Bearer " prefix are stripped.
 */
export function normalizeApiKey(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let key = raw.trim().replace(/^["']|["']$/g, '').trim();
  key = key.replace(/^bearer\s+/i, '').trim();
  return key.length > 0 ? key : undefined;
}

/** Returns an error message when the URL is unusable, otherwise undefined. */
export function validateUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `RAY_MCP_URL is not a valid URL: "${url}". Unset it to use the default ${DEFAULT_MCP_URL}.`;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return `RAY_MCP_URL must be an http(s) URL, got "${url}". Unset it to use the default ${DEFAULT_MCP_URL}.`;
  }
  return undefined;
}
