# @htmldrop.app/mcp

Model Context Protocol server for [htmldrop](https://htmldrop.app) — publish HTML or Markdown to a real hosted URL straight from Claude Code, Claude Desktop, Cursor, Cline, or any MCP-aware client.

> **Note:** this is htmldrop.app. An unrelated project also called "htmldrop" exists at htmldrop.link (npm `htmldrop-mcp`) — different product, different API.

## Quick start — remote server (recommended)

No install, no API keys. Add the hosted server and sign in with OAuth in your browser:

```
claude mcp add --transport http htmldrop https://htmldrop.app/mcp
```

The first time the model publishes, your browser opens a sign-in — approve once and you're done. Works the same in any MCP client that supports remote (streamable HTTP) servers with OAuth; see the per-client pages on [htmldrop.app/agents](https://htmldrop.app/agents/).

Then just ask: *"Make a single-page HTML CV for Alex Rivera and publish it to htmldrop."* The model calls `htmldrop_publish` and replies with the live URL.

## Local server (stdio) — for CI, scripts, and clients without remote support

> **Prefer the remote server above for interactive use.** The stdio server authenticates with a static API token — the standard MCP pattern for local servers, but it's a full-privilege credential in a config file. Use it where OAuth can't reach: CI pipelines, headless scripts, clients without remote MCP support, or self-hosted instances. In CI, inject the token from your secret store (GitHub Actions secrets, etc.), never inline.

1. **Create an API token.** Sign in at [htmldrop.app/dashboard/settings](https://htmldrop.app/dashboard/settings) → API tokens → Create token. Copy the `hsk_live_…` value — it's shown only once.

2. **Add to your MCP client config.** For **Claude Desktop** edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

   ```json
   {
     "mcpServers": {
       "htmldrop": {
         "command": "npx",
         "args": ["-y", "@htmldrop.app/mcp"],
         "env": {
           "HTMLDROP_API_TOKEN": "hsk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
         }
       }
     }
   }
   ```

   For **Claude Code**: `claude mcp add htmldrop --env HTMLDROP_API_TOKEN=hsk_live_... -- npx -y @htmldrop.app/mcp`

   For **Cursor**: Settings → MCP → Add server with command `npx`, args `["-y", "@htmldrop.app/mcp"]`, env `HTMLDROP_API_TOKEN`.

   For **Cline** (VS Code): open Cline's MCP Settings panel and add the same `npx` block.

3. **Restart your MCP client.** It fetches and launches the server on first use.

## Tools

| Tool | What it does |
|---|---|
| `htmldrop_publish` | Publish an HTML or Markdown document. Returns the public share URL, site id, and slug. Accepts an optional `slug` and `title`. |
| `htmldrop_list` | List every site the authenticated tenant owns. |
| `htmldrop_delete` | Delete a site by id. |

## Configuration (local server)

| Env var | Default | Purpose |
|---|---|---|
| `HTMLDROP_API_TOKEN` | *(required for stdio)* | The `hsk_live_…` token minted in your dashboard. The remote server uses OAuth instead. |
| `HTMLDROP_API_URL` | `https://htmldrop.app/api/v1` | Override for staging or self-hosted htmldrop instances. |
| `HTMLDROP_PUBLIC_URL` | *(derived from `HTMLDROP_API_URL`)* | User-facing origin for share links (`…/s/<slug>`). Only needed when `HTMLDROP_API_URL` points at a non-public address; set it to e.g. `https://htmldrop.app`. |

## Plan limits

The MCP server hits the same API your dashboard does, so plan caps apply — free accounts keep 3 drops, paid plans (from $5/mo) raise caps and add permanence, password protection, version history, and custom domains. Current numbers: [htmldrop.app/#pricing](https://htmldrop.app/#pricing). When you hit a cap the tool call returns a clear error (`plan_limit`) that the model surfaces in chat — no silent failure.

## Security notes

- The remote server (`https://htmldrop.app/mcp`) follows the MCP authorization spec: OAuth 2.1 with PKCE, discovery via RFC 9728 protected-resource metadata, and short-lived tokens your client refreshes automatically. Tokens are never passed in URLs. This is the recommended path for humans in MCP clients — no static credential exists anywhere.
- Local-server API tokens (`hsk_live_…`) carry full tenant privileges — treat them like a password. Keep them out of source control, store them in a secret manager or your CI's encrypted secrets (not a committed config file), and revoke from Settings → API tokens the moment one may have leaked (revocation is effective immediately). The `.mcpb` one-click install for Claude Desktop stores the token in your OS keychain rather than a plaintext file.
- The stdio server runs on your machine. No traffic flows through htmldrop other than the API calls the tool makes on your behalf.

## Development

```
npm ci
npm test        # builds + runs the node:test suite
```

This repository is a read-only mirror of the `mcp/` directory in htmldrop's main (private) repository — the source of truth. Issues and PRs are welcome here; accepted changes are applied upstream and sync back automatically.

## License

MIT — © Middle East Software Solutions Limited
