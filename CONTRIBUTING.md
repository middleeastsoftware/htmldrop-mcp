# Contributing

Thanks for your interest in the htmldrop MCP server.

**This public repository is a read-only mirror** of the `mcp/` directory in
htmldrop's main (private) monorepo, which is the source of truth. Every change
merged upstream syncs here automatically, so the mirror always matches what's
published to npm.

What that means in practice:

- **Issues:** file them here — bug reports, feature requests, and client-compat
  problems are all welcome and watched.
- **Pull requests:** welcome here too. A maintainer applies accepted changes
  upstream (with credit in the commit), and the mirror updates on the next
  sync — your PR is then closed as merged-upstream.
- **Direct pushes** to this repo would be overwritten by the sync; don't build
  on top of a fork's main for anything long-lived.

## Local development

```
npm ci
npm test        # tsc build + node:test suite
```

`HTMLDROP_MCP_MODE=http PORT=3000 node dist/index.js` runs the streamable-HTTP
mode locally; plain `node dist/index.js` runs stdio mode (needs
`HTMLDROP_API_TOKEN`).

## Security

If you believe you've found a security issue in this server or in
htmldrop.app, please email security@htmldrop.app rather than opening a public
issue.
