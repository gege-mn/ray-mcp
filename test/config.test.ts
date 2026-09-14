import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MCP_URL, normalizeApiKey, readConfig, validateUrl } from '../src/config.js';
import { PACKAGE_NAME, VERSION } from '../src/version.js';

const readJson = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));

describe('config', () => {
  it('reads env with defaults', () => {
    expect(readConfig({})).toEqual({ apiKey: undefined, url: DEFAULT_MCP_URL });
    expect(readConfig({ RAY_API_KEY: ' ck_live_abc ', RAY_MCP_URL: 'http://localhost:8787/mcp' })).toEqual({
      apiKey: 'ck_live_abc',
      url: 'http://localhost:8787/mcp',
    });
  });

  it('normalizes pasted keys', () => {
    expect(normalizeApiKey('')).toBeUndefined();
    expect(normalizeApiKey('   ')).toBeUndefined();
    expect(normalizeApiKey('"ck_live_abc"')).toBe('ck_live_abc');
    expect(normalizeApiKey('Bearer ck_live_abc')).toBe('ck_live_abc');
  });

  it('validates the endpoint URL', () => {
    expect(validateUrl(DEFAULT_MCP_URL)).toBeUndefined();
    expect(validateUrl('ftp://example.com')).toContain('http(s)');
    expect(validateUrl('nope')).toContain('not a valid URL');
  });
});

describe('release metadata', () => {
  it('keeps versions and names in sync across package.json, server.json and the source', () => {
    const pkg = readJson('package.json');
    const server = readJson('server.json');
    expect(pkg.version).toBe(VERSION);
    expect(pkg.name).toBe(PACKAGE_NAME);
    expect(pkg.mcpName).toBe(server.name);
    expect(server.version).toBe(VERSION);
    expect(server.packages[0].identifier).toBe(PACKAGE_NAME);
    expect(server.packages[0].version).toBe(VERSION);
    expect(server.remotes[0].url).toBe(DEFAULT_MCP_URL);
  });
});
