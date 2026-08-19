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

## Releasing

Publishing is tag-driven. Bump the version in **all four** carriers first —
`package.json`, `package-lock.json`, `manifest.json` (the .mcpb bundle) and
`server.json` (the MCP registry manifest) — then merge and tag:

```
git tag mcp-v<version> && git push origin mcp-v<version>
```

`.github/workflows/mcp-publish.yaml` then verifies the tag matches
`package.json`, publishes to npm (Trusted Publishing via OIDC — there is no
NPM_TOKEN in the flow), attaches `server.mcpb` to a GitHub release, and
publishes `server.json` to the MCP registry.

### How the registry auth works

The registry proves domain ownership over HTTP: it fetches
`https://htmldrop.app/.well-known/mcp-registry-auth` (served from
`marketing/.well-known/`) and checks it against a signature made with our
Ed25519 key. There is **no DNS TXT record** for this — HTTP is the only path
that works for `htmldrop.app`.

CI signs with the `MCP_REGISTRY_KEY` secret. That secret is the raw 32-byte
Ed25519 seed as **hex**, which is what `mcp-publisher login` expects — not the
PEM. To regenerate it from the key file:

```
python3 -c "
import base64
pem = open('~/.config/htmldrop/mcp-registry-ed25519.pem').read()
der = base64.b64decode(''.join(l for l in pem.splitlines() if 'BEGIN' not in l and 'END' not in l))
print(der[-32:].hex())"
```

The public half must match the `p=` value in the served auth file.

### When the registry is down

It has been observed refusing connections for minutes at a time. The step
retries five times, but if a release still gets through to npm and fails at the
registry, re-run the workflow manually with **registry_only=true** — that skips
npm and the release asset (which cannot be repeated for an existing version)
and only re-publishes `server.json`.
