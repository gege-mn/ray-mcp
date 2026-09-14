# Ray MCP server

[![npm](https://img.shields.io/npm/v/@gege-mn/ray-mcp)](https://www.npmjs.com/package/@gege-mn/ray-mcp)
[![CI](https://github.com/gege-mn/ray-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/gege-mn/ray-mcp/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

MCP server for **[Ray](https://ray.gege.mn)**, the notification delivery API. It lets Claude, Cursor, VS Code, Windsurf, Codex, Zed and any other MCP client send notifications and manage templates, delivery webhooks and usage in your Ray workspace.

> Ray here is the multi-tenant notification API from gege.mn (email via Amazon SES or SMTP, Firebase push, Slack, Discord, Telegram, generic webhooks and an in-app feed). It is **not** the Ray distributed computing framework.

## Hosted or local?

Ray runs an MCP server for you. There are two ways to connect, with the same tools:

| | Hosted (recommended) | Local (this package) |
| --- | --- | --- |
| What runs | Nothing on your machine | `npx -y @gege-mn/ray-mcp`, a stdio process |
| Endpoint | `https://ray-api.gege.mn/mcp` (Streamable HTTP) | Bridges to the hosted endpoint |
| Auth | `Authorization: Bearer <key>` header | `RAY_API_KEY` environment variable |
| Use it when | Your client supports remote servers with custom headers | Your client only runs stdio servers (e.g. Claude Desktop config file), or you prefer env vars over headers |

This package is a thin bridge: it connects to the hosted endpoint with your key and mirrors its tool list, descriptions and instructions, so new tools appear without upgrading the package. All validation, scopes, rate limits and quota are enforced by Ray's API.

## 1. Get an API key

1. Sign in at [ray.gege.mn](https://ray.gege.mn) and open **API keys**.
2. Create a key. It starts with `ck_live_` and is shown only once.
   - `read` scope: status, templates, usage, docs.
   - `write` scope: also needed to send, create or change templates, and manage webhooks.
3. Configure at least one channel in the dashboard under **Channels**. Channel credentials can't be created through the API or MCP.

The examples below use `ck_live_...` as a placeholder. Keep real keys out of version control.

## 2. Add Ray to your client

### Claude Code

Hosted:

```bash
claude mcp add --transport http ray https://ray-api.gege.mn/mcp --header "Authorization: Bearer $RAY_API_KEY"
```

Local:

```bash
claude mcp add ray --env RAY_API_KEY=ck_live_... -- npx -y @gege-mn/ray-mcp
```

Add `--scope user` to make it available in every project. Check the connection with `claude mcp get ray`.

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config; macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json`), then fully restart Claude Desktop:

```json
{
  "mcpServers": {
    "ray": {
      "command": "npx",
      "args": ["-y", "@gege-mn/ray-mcp"],
      "env": { "RAY_API_KEY": "ck_live_..." }
    }
  }
}
```

### Cursor

`.cursor/mcp.json` in a project, or `~/.cursor/mcp.json` for all projects.

Hosted:

```json
{
  "mcpServers": {
    "ray": {
      "url": "https://ray-api.gege.mn/mcp",
      "headers": { "Authorization": "Bearer ck_live_..." }
    }
  }
}
```

Local:

```json
{
  "mcpServers": {
    "ray": {
      "command": "npx",
      "args": ["-y", "@gege-mn/ray-mcp"],
      "env": { "RAY_API_KEY": "ck_live_..." }
    }
  }
}
```

Cursor can read the key from your environment instead: `"Authorization": "Bearer ${env:RAY_API_KEY}"`.

### VS Code (GitHub Copilot)

VS Code's `mcp.json` (`.vscode/mcp.json` in a workspace, or **MCP: Open User Configuration**) uses a top-level `servers` key and can prompt for the key so it isn't stored in the file:

```json
{
  "inputs": [
    { "id": "ray-api-key", "type": "promptString", "description": "Ray API key (ck_live_...)", "password": true }
  ],
  "servers": {
    "ray": {
      "type": "http",
      "url": "https://ray-api.gege.mn/mcp",
      "headers": { "Authorization": "Bearer ${input:ray-api-key}" }
    }
  }
}
```

Local variant: replace the server entry with `{ "type": "stdio", "command": "npx", "args": ["-y", "@gege-mn/ray-mcp"], "env": { "RAY_API_KEY": "${input:ray-api-key}" } }`.

### Windsurf

`~/.codeium/windsurf/mcp_config.json` (Windsurf calls the URL field `serverUrl` and supports `${env:VAR}`):

```json
{
  "mcpServers": {
    "ray": {
      "serverUrl": "https://ray-api.gege.mn/mcp",
      "headers": { "Authorization": "Bearer ${env:RAY_API_KEY}" }
    }
  }
}
```

Local: use the same `command` / `args` / `env` entry as in the Cursor example.

### Codex

`~/.codex/config.toml`, local:

```toml
[mcp_servers.ray]
command = "npx"
args = ["-y", "@gege-mn/ray-mcp"]
env = { RAY_API_KEY = "ck_live_..." }
```

Hosted, reading the key from your shell environment:

```toml
[mcp_servers.ray]
url = "https://ray-api.gege.mn/mcp"
bearer_token_env_var = "RAY_API_KEY"
```

Or from the CLI: `codex mcp add ray --env RAY_API_KEY=ck_live_... -- npx -y @gege-mn/ray-mcp`.

### Zed

In Zed's `settings.json`:

```json
{
  "context_servers": {
    "ray": {
      "url": "https://ray-api.gege.mn/mcp",
      "headers": { "Authorization": "Bearer ck_live_..." }
    }
  }
}
```

Local: `"ray": { "command": "npx", "args": ["-y", "@gege-mn/ray-mcp"], "env": { "RAY_API_KEY": "ck_live_..." } }`.

### Any other client

Any client that runs stdio servers:

```json
{
  "mcpServers": {
    "ray": {
      "command": "npx",
      "args": ["-y", "@gege-mn/ray-mcp"],
      "env": { "RAY_API_KEY": "ck_live_..." }
    }
  }
}
```

Any client that supports Streamable HTTP: URL `https://ray-api.gege.mn/mcp`, header `Authorization: Bearer ck_live_...`.

## Environment variables (local package)

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `RAY_API_KEY` | yes | | Ray API key (`ck_live_...`). Whitespace, quotes and a `Bearer ` prefix are stripped. |
| `RAY_MCP_URL` | no | `https://ray-api.gege.mn/mcp` | Hosted endpoint to bridge to. Only change it for staging or local development. |

CLI flags: `--help`, `--version`. Requires Node.js 18 or newer.

## Tools

The tool list comes from the hosted server, so it can grow over time; your client shows the authoritative descriptions and input schemas. Current tools:

| Tool | What it does |
| --- | --- |
| `whoami` | Shows the workspace, key id and scopes of the API key in use. |
| `get_usage` | Plan, subscription status and this month's usage against the quota. |
| `list_channels` | Configured channels with their ids and the recipient shape each accepts. Call first. |
| `send_notification` | Sends a notification (single, fan-out, multi-channel or feed-only). Needs `write`. |
| `get_send_status` | Delivery status of a send, with per-recipient rows. |
| `list_templates` | Lists message templates. |
| `get_template` | One template with its published version and draft. |
| `create_template` | Creates a template, optionally publishing it. Needs `write`. |
| `update_template_draft` | Replaces a template's draft. Needs `write`. |
| `publish_template` | Publishes a template's draft as the live version. Needs `write`. |
| `archive_template` | Archives a template. Needs `write`. |
| `unarchive_template` | Restores an archived template. Needs `write`. |
| `test_send_template` | Sends a real test of a published template to one recipient. Needs `write`. |
| `list_feed_notifications` | Reads one end user's in-app notification feed. |
| `get_click_stats` | Email link click counts for a send or campaign. |
| `list_webhooks` | Lists outbound event webhooks and their delivery health. |
| `get_webhook` | One outbound webhook. |
| `create_webhook` | Creates an outbound webhook; returns its signing secret once. Needs `write`. |
| `update_webhook` | Changes a webhook or rotates its secret. Needs `write`. |
| `delete_webhook` | Deletes a webhook. Needs `write`. |
| `read_docs` | Reads Ray's documentation as markdown. |

Read-only tools are annotated `readOnlyHint`; archive and delete tools are annotated `destructiveHint`, so clients can ask before running them.

## Example prompts

- "Send a test email to me through Ray."
- "Which Ray channels do I have, and what recipient does each one need?"
- "Create and publish a welcome email template in Ray with a `firstName` param, then test-send it to me."
- "Did send `snd_...` get delivered? Show me any failures."
- "How many notifications have we sent this month, and how much quota is left?"
- "Set up a Ray webhook to `https://example.com/hooks/ray` for failed deliveries."

## Troubleshooting

The local package always starts, even when something is wrong, and explains the problem through MCP instead of crashing. Diagnostics go to stderr (your client's MCP log); stdout carries only MCP messages.

- **Only a `setup_help` tool is listed.** The server can't load Ray's tools. Its description says why. Without `RAY_API_KEY` every tool call returns setup steps. If the endpoint was unreachable, call `setup_help` after fixing the cause: it retries, and on success the client is told the tool list changed. If your client doesn't refresh, reload the server.
- **"Ray rejected the API key (HTTP 401)".** The key is wrong, revoked, or was pasted incompletely. Create a new key at [ray.gege.mn](https://ray.gege.mn), update the config and restart the client.
- **"write scope required" or HTTP 403.** The key is read-only, or your plan doesn't include the feature (webhooks need Pro or higher). Use a key with the `write` scope.
- **HTTP 402 / quota.** The workspace used its monthly quota. Check with `get_usage`.
- **HTTP 429.** Rate limited; the error says how many seconds to wait. See [rate limits](https://ray.gege.mn/docs/rate-limits).
- **"Could not reach Ray's MCP endpoint (ECONNREFUSED / ENOTFOUND / ...)".** Network, proxy or firewall problem, or a wrong `RAY_MCP_URL`.
- **`npx` not found or old Node.** Install Node.js 18+ and make sure `npx` is on the PATH your client uses. On macOS GUI apps may not see shell PATH changes; use an absolute path to `npx` if needed.
- **Check the server by hand:** `RAY_API_KEY=ck_live_... npx -y @gege-mn/ray-mcp` should log `connected to https://ray-api.gege.mn/mcp` on stderr, then wait for input (Ctrl+C to exit). Or inspect it with `npx @modelcontextprotocol/inspector npx -y @gege-mn/ray-mcp`.

## Related

- Docs: [ray.gege.mn/docs](https://ray.gege.mn/docs), with an index for agents at [ray.gege.mn/llms.txt](https://ray.gege.mn/llms.txt) (append `.md` to any docs URL for raw markdown). The MCP setup guide is [Using Ray with AI coding agents](https://ray.gege.mn/docs/ai-agents).
- API reference: [ray-api.gege.mn/docs](https://ray-api.gege.mn/docs), OpenAPI at [ray-api.gege.mn/openapi.json](https://ray-api.gege.mn/openapi.json).
- TypeScript SDK: [`@gege-mn/ray`](https://www.npmjs.com/package/@gege-mn/ray) ([gege-mn/ray-node](https://github.com/gege-mn/ray-node)).
- Agent skills and Claude Code plugin: [gege-mn/ray-skills](https://github.com/gege-mn/ray-skills) (`npx skills add gege-mn/ray-skills`).

## Development

```bash
pnpm install
pnpm typecheck
pnpm test        # vitest: bridge end to end against an in-process fake Ray endpoint
pnpm build       # tsup -> dist/index.js
pnpm smoke       # the built binary over real stdio
RAY_MCP_URL=http://localhost:8787/mcp RAY_API_KEY=ck_live_... node dist/index.js
```

Releasing: bump the version in `package.json`, `server.json` (both `version` fields) and `src/version.ts`, update `CHANGELOG.md`, then publish a GitHub release tagged `vX.Y.Z`. The publish workflow ships to npm and the MCP Registry. To publish by hand instead: `pnpm publish --access public`, then run the **MCP Registry** workflow (a personal `mcp-publisher login github` can't publish under the gege-mn namespace).

## License

[MIT](LICENSE) © gege.mn
