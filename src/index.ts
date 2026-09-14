import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBridge } from './bridge.js';
import { DASHBOARD_URL, DEFAULT_MCP_URL, DOCS_URL, readConfig } from './config.js';
import { PACKAGE_NAME, VERSION } from './version.js';

const HELP = `${PACKAGE_NAME} ${VERSION}
Local stdio MCP server for Ray, the notification delivery API.
It mirrors the tools of Ray's hosted MCP endpoint (${DEFAULT_MCP_URL}).

Usage:
  npx -y ${PACKAGE_NAME}            start the stdio MCP server (run by your MCP client)
  npx -y ${PACKAGE_NAME} --help     show this help
  npx -y ${PACKAGE_NAME} --version  print the version

Environment:
  RAY_API_KEY   required  Ray API key (ck_live_...), created at ${DASHBOARD_URL} under "API keys"
  RAY_MCP_URL   optional  hosted MCP endpoint, default ${DEFAULT_MCP_URL}

Example client config:
  {
    "mcpServers": {
      "ray": {
        "command": "npx",
        "args": ["-y", "${PACKAGE_NAME}"],
        "env": { "RAY_API_KEY": "ck_live_..." }
      }
    }
  }

Docs: ${DOCS_URL}   Source: https://github.com/gege-mn/ray-mcp
`;

function log(message: string): void {
  process.stderr.write(`[ray-mcp] ${message}\n`);
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const unknown = argv.filter((arg) => arg.startsWith('-'));
  if (unknown.length > 0) {
    log(`ignoring unknown option(s): ${unknown.join(' ')} (see --help)`);
  }

  const config = readConfig();
  let parsedUrl: URL | undefined;
  try {
    parsedUrl = new URL(config.url);
  } catch {
    // Reported to the agent by the bridge's setup_help tool.
  }
  if (parsedUrl?.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname)) {
    log(`warning: RAY_MCP_URL uses plain http; your API key is sent unencrypted to ${parsedUrl.host}`);
  }

  const bridge = await createBridge({ apiKey: config.apiKey, url: config.url, log });
  const transport = new StdioServerTransport();

  let closing = false;
  const shutdown = async (code: number) => {
    if (closing) return;
    closing = true;
    try {
      await bridge.close();
    } catch {
      // Exiting anyway.
    }
    process.exit(code);
  };

  // The client closed stdin: answer whatever it already sent, then exit.
  const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const drainAndExit = () => {
    void (async () => {
      await nextTick(); // let already-read messages reach their handlers
      await bridge.idle();
      await nextTick(); // let the SDK write the final responses
      await shutdown(0);
    })();
  };

  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
  process.stdin.on('end', drainAndExit);
  process.stdin.on('close', drainAndExit);
  // The client went away mid-write: nothing left to talk to.
  process.stdout.on('error', () => void shutdown(0));

  await bridge.server.connect(transport);
  log(`stdio server ready (${PACKAGE_NAME} ${VERSION}, endpoint ${config.url})`);
}

process.on('unhandledRejection', (reason) => {
  log(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});

main(process.argv.slice(2)).catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
