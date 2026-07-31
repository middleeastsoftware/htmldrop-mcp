// HTTP-mode authorization policy for the hosted MCP endpoint.
//
// Standards followed:
//   - MCP authorization spec: protected requests answer 401 with a
//     WWW-Authenticate challenge pointing at the RFC 9728 protected-
//     resource metadata, which is what triggers the client's OAuth
//     flow. initialize / tools/list stay open so directory scanners
//     (Smithery, Anthropic's connector indexer) can probe
//     capabilities without credentials.
//   - RFC 6750: bearer tokens in the Authorization header only; the
//     query-string is never accepted (tokens in URLs end up in access
//     logs and caches). §3.1: a request with no credentials gets a
//     challenge WITHOUT an error code; a rejected token gets
//     error="invalid_token" — clients use that to refresh.
//
// The Smithery gateway forwards user-configured parameters as headers
// named after the parameter, so the conventional header aliases remain
// accepted alongside the standard Authorization header.

type HeaderMap = Record<string, string | string[] | undefined>;

const ALIAS_HEADERS = ["apitoken", "x-api-token", "x-htmldrop-token", "htmldrop-token"];

export function parseToken(headers: HeaderMap, _url: string): string {
  const auth = headers["authorization"];
  const found = typeof auth === "string" ? auth.match(/^Bearer\s+(.+)$/) : null;
  const bearer = (found?.[1] ?? "").trim();
  if (bearer) return bearer;
  for (const name of ALIAS_HEADERS) {
    const v = headers[name];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

// needsAuth reports whether a parsed JSON-RPC body (single request or
// batch) contains a call that requires credentials. Only tools/call is
// protected: capability discovery stays anonymous.
export function needsAuth(body: unknown): boolean {
  const isProtected = (m: unknown): boolean =>
    typeof m === "object" && m !== null && (m as { method?: unknown }).method === "tools/call";
  if (Array.isArray(body)) return body.some(isProtected);
  return isProtected(body);
}

export function buildWwwAuthenticate(
  resourceMetadataUrl: string,
  opts?: { invalid?: boolean },
): string {
  const parts = [`Bearer resource_metadata="${resourceMetadataUrl}"`, `scope="mcp"`];
  if (opts?.invalid) parts.splice(1, 0, `error="invalid_token"`);
  return parts.join(", ");
}

// TokenVerdictCache remembers recent token validations so the
// preflight check doesn't double every tool call's API traffic.
// Keyed by caller-supplied key (hash the token before storing).
export class TokenVerdictCache {
  private entries = new Map<string, { ok: boolean; at: number }>();
  private ttlMs: number;
  private maxEntries: number;
  private clock: () => number;

  constructor(opts?: { ttlMs?: number; maxEntries?: number; clock?: () => number }) {
    this.ttlMs = opts?.ttlMs ?? 60_000;
    this.maxEntries = opts?.maxEntries ?? 1024;
    this.clock = opts?.clock ?? Date.now;
  }

  get(key: string): boolean | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (this.clock() - e.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return e.ok;
  }

  set(key: string, ok: boolean): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { ok, at: this.clock() });
  }
}
