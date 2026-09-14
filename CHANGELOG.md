# Changelog

All notable changes to `@gege-mn/ray-mcp` are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

### Added

- Stdio MCP server that bridges to Ray's hosted MCP endpoint (`https://ray-api.gege.mn/mcp`) and mirrors its tools, instructions and server info.
- `RAY_API_KEY` (required) and `RAY_MCP_URL` (optional) configuration.
- Readable tool errors for invalid keys (401), missing scopes (403), quota (402), rate limits (429), server errors and network failures. The process never exits because of a remote error.
- `setup_help` placeholder tool when the key is missing or the endpoint is unreachable, with automatic recovery and `notifications/tools/list_changed` once Ray is reachable.
- `--help` and `--version` flags.
- MCP Registry `server.json`, `glama.json` and `smithery.yaml`.

[0.1.0]: https://github.com/gege-mn/ray-mcp/releases/tag/v0.1.0
