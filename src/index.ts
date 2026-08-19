#!/usr/bin/env node
// htmldrop-mcp is a Model Context Protocol server. It speaks two
// transports off the same tool implementations:
//
//   stdio — npx / Claude Desktop / Cursor local install; reads
//           HTMLDROP_API_TOKEN from env at boot.
//   http  — hosted at https://htmldrop.app/mcp; reads the API token
//           from the `Authorization: Bearer ...` header per request,
//           so Smithery / Anthropic's connector flow can fan out
//           multiple users through one process.
//
// Mode is selected by the HTMLDROP_MCP_MODE env var ("stdio" default,
// "http" enables the HTTP listener). The two modes share the same
// Server instance + tool handlers; AsyncLocalStorage carries the
// per-request token to apiCall().
//
// Tools exposed:
//   htmldrop_publish — create a new site from HTML or Markdown; returns the public URL
//   htmldrop_list    — list every site under the authenticated tenant
//   htmldrop_delete  — remove a site by id

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import http from "node:http";
import { buildWwwAuthenticate, needsAuth, parseToken, TokenVerdictCache } from "./auth.js";

const SERVER_NAME = "htmldrop";
const SERVER_VERSION = "0.3.4";

// ── token plumbing ─────────────────────────────────────────────────

// AsyncLocalStorage threads the per-request token through the tool
// handler call stack without making every function take an explicit
// token argument. stdio mode populates it once at boot from the env
// var; HTTP mode populates it per request from the Authorization
// header before dispatching to the transport.
const tokenStore = new AsyncLocalStorage<string>();

// clientInfoStore mirrors tokenStore: it carries the per-connection
// MCP clientInfo (name + version) from the protocol handshake down
// into apiCall so we can attach an X-Htmldrop-Client header on every
// request. Captured in `oninitialized` (set inside makeServer).
const clientInfoStore = new AsyncLocalStorage<{ name: string; version: string }>();

function currentToken(): string {
  const t = tokenStore.getStore();
  if (t && t.length > 0) return t;
  return (process.env.HTMLDROP_API_TOKEN ?? "").trim();
}

const apiBase = (process.env.HTMLDROP_API_URL ?? "https://htmldrop.app/api/v1").replace(
  /\/+$/,
  "",
);

// publicBase is the user-facing origin used to build public share URLs
// (…/s/<slug>). By default it's apiBase with the "/api/…" path stripped,
// which is correct when the API is reached at its public origin. But
// hosted deployments point HTMLDROP_API_URL at an INTERNAL cluster address
// (e.g. an in-cluster service address rather than the public origin) for fast
// pod-to-pod calls — deriving the share host from that would hand clients
// an unreachable URL. Set HTMLDROP_PUBLIC_URL to the user-facing origin
// (e.g. https://htmldrop.app) in that case.
const publicBase = (() => {
  const explicit = (process.env.HTMLDROP_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const i = apiBase.indexOf("/api/");
  return i >= 0 ? apiBase.slice(0, i) : apiBase;
})();

// ── API client ─────────────────────────────────────────────────────

interface SiteRow {
  id: string;
  slug: string;
  custom_domain?: string;
  path_prefix?: string;
}

class HtmldropError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HtmldropError";
  }
}

async function apiCall<T = unknown>(
  method: string,
  path: string,
  body?: { json?: unknown; multipart?: FormData },
): Promise<T> {
  const token = currentToken();
  if (!token) {
    throw new HtmldropError(
      "No API token. Set HTMLDROP_API_TOKEN (stdio) or pass an Authorization: Bearer header (http).",
    );
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  const client = clientInfoStore.getStore();
  if (client?.name) {
    headers["X-Htmldrop-Client"] = client.version
      ? `${client.name}/${client.version}`
      : client.name;
  }
  let payload: BodyInit | undefined;
  if (body?.json !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body.json);
  } else if (body?.multipart) {
    payload = body.multipart;
  }
  const res = await fetch(`${apiBase}${path}`, { method, headers, body: payload });
  const raw = await res.text();
  if (!res.ok) {
    let parsed: { error?: string; detail?: string } = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* not JSON */
    }
    const tail = parsed.detail ? `: ${parsed.detail}` : "";
    const headline = parsed.error ?? (raw || res.statusText);
    throw new HtmldropError(`${method} ${path} → ${res.status} ${headline}${tail}`);
  }
  if (!raw) return undefined as T;
  return JSON.parse(raw) as T;
}

async function createSite(slug?: string): Promise<SiteRow> {
  return apiCall<SiteRow>("POST", "/sites", slug ? { json: { slug } } : undefined);
}

async function listSites(): Promise<SiteRow[]> {
  // GET /sites returns a bare top-level JSON array (see httpapi
  // handleSiteList → c.JSON(out)), not a {results:[…]} envelope.
  const r = await apiCall<SiteRow[]>("GET", "/sites");
  return Array.isArray(r) ? r : [];
}

async function deleteSite(id: string): Promise<void> {
  await apiCall<void>("DELETE", `/sites/${encodeURIComponent(id)}`);
}

async function uploadHTML(siteId: string, html: string): Promise<void> {
  const fd = new FormData();
  fd.set("file", new Blob([html], { type: "text/html; charset=utf-8" }), "index.html");
  await apiCall<unknown>("POST", `/sites/${encodeURIComponent(siteId)}/upload`, {
    multipart: fd,
  });
}

async function uploadMarkdown(siteId: string, title: string, markdown: string): Promise<void> {
  await apiCall<unknown>("POST", `/sites/${encodeURIComponent(siteId)}/upload-md`, {
    json: { title: title || "Untitled", markdown },
  });
}

function shareURL(s: SiteRow): string {
  if (s.custom_domain) {
    const tail = s.path_prefix ? `/${s.path_prefix}` : "";
    return `https://${s.custom_domain}${tail}`;
  }
  return `${publicBase}/s/${s.slug}`;
}

// ── tool definitions ───────────────────────────────────────────────

// Tool definitions ship inputSchema, outputSchema, AND MCP
// annotations (readOnlyHint / destructiveHint / idempotentHint /
// openWorldHint). The annotations help host clients reason about
// safety (e.g. autoconfirm read-only calls but always prompt for
// destructive ones); the output schema enables structured-content
// tool results.
const TOOL_DEFS = [
  {
    name: "htmldrop_publish",
    description:
      "Publish an HTML or Markdown document as a hosted page on htmldrop. Returns the public share URL. Use this whenever a user asks to publish, share, or 'put on the web' some HTML / Markdown content. Pass exactly one of `html` or `markdown`.",
    inputSchema: {
      type: "object" as const,
      properties: {
        html: { type: "string", description: "Raw HTML document content. Either this or `markdown` must be set." },
        markdown: { type: "string", description: "Markdown content. Will be rendered to HTML on the server. Either this or `html` must be set." },
        slug: { type: "string", description: "Optional URL slug (3-63 chars, lowercase letters, numbers, hyphens). If omitted, a random slug is assigned." },
        title: { type: "string", description: "Optional title shown in the dashboard list." },
      },
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "Public share URL of the published page." },
        id: { type: "string", description: "Opaque site id. Pass to htmldrop_delete to remove later." },
        slug: { type: "string", description: "Resolved slug for the published site." },
      },
      required: ["url", "id", "slug"],
    },
    annotations: {
      title: "Publish to htmldrop",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "htmldrop_list",
    description:
      "List every site the authenticated tenant has published. Returns each site's slug, id, and public URL.",
    inputSchema: { type: "object" as const, properties: {} },
    outputSchema: {
      type: "object" as const,
      properties: {
        sites: {
          type: "array",
          description: "Every published site for the authenticated tenant.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              slug: { type: "string" },
              url: { type: "string" },
            },
            required: ["id", "slug", "url"],
          },
        },
      },
      required: ["sites"],
    },
    annotations: {
      title: "List htmldrop sites",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "htmldrop_delete",
    description:
      "Delete a site by its id. The id is the opaque string returned from htmldrop_list (NOT the slug). Once deleted the public URL returns 404 immediately.",
    inputSchema: {
      type: "object" as const,
      properties: { id: { type: "string", description: "The site's id, as returned by htmldrop_list." } },
      required: ["id"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "The deleted site's id." },
        deleted: { type: "boolean", description: "Always true on success." },
      },
      required: ["id", "deleted"],
    },
    annotations: {
      title: "Delete htmldrop site",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
];

// ── tool implementations ───────────────────────────────────────────

interface PublishArgs {
  html?: string;
  markdown?: string;
  slug?: string;
  title?: string;
}

// Each runner returns both a human-readable text summary AND a
// structured-content object that matches the outputSchema declared
// on the tool. Hosts that understand structured content (Smithery,
// MCP Inspector, Claude Desktop's tool-result formatter) render the
// structured form; text is the fallback.
interface ToolResult {
  text: string;
  structured: Record<string, unknown>;
}

async function runPublish(args: PublishArgs): Promise<ToolResult> {
  const html = (args.html ?? "").trim();
  const markdown = (args.markdown ?? "").trim();
  if (!html && !markdown) throw new Error("either `html` or `markdown` is required");
  if (html && markdown)
    throw new Error("pass exactly one of `html` or `markdown`, not both");
  const site = await createSite(args.slug?.trim() || undefined);
  if (markdown) {
    await uploadMarkdown(site.id, args.title ?? "Untitled", markdown);
  } else {
    await uploadHTML(site.id, html);
  }
  const url = shareURL(site);
  return {
    text: `Published. Public URL: ${url}\nSite id: ${site.id}\nSlug: ${site.slug}`,
    structured: { url, id: site.id, slug: site.slug },
  };
}

async function runList(): Promise<ToolResult> {
  const sites = await listSites();
  const rows = sites.map((s) => ({ id: s.id, slug: s.slug, url: shareURL(s) }));
  if (sites.length === 0) {
    return {
      text: "No sites yet. Use htmldrop_publish to create one.",
      structured: { sites: [] },
    };
  }
  const lines = rows.map((r) => `  - id=${r.id}  slug=${r.slug}  url=${r.url}`);
  return {
    text: `${sites.length} site${sites.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
    structured: { sites: rows },
  };
}

async function runDelete(args: { id?: string }): Promise<ToolResult> {
  const id = (args.id ?? "").trim();
  if (!id) throw new Error("`id` is required");
  await deleteSite(id);
  return {
    text: `Deleted site ${id}.`,
    structured: { id, deleted: true },
  };
}

// ── server factory ─────────────────────────────────────────────────

// makeServer builds a fresh Server instance. We make one per stdio
// boot, and one per HTTP request in stateless HTTP mode so the SDK's
// internal request/notification routing doesn't get tangled between
// concurrent requests.
function makeServer(): Server {
  const s = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    // We expose tools only — resources and prompts stay off the
    // capability list so spec-conformant clients don't probe them.
    // Smithery's scanner does probe regardless, so the empty
    // handlers below keep its output free of "method not found"
    // warnings.
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  // After the SDK processes `initialize`, getClientVersion() returns
  // the client's Implementation. Hoist it into a closure variable
  // so the CallTool handler below can park it in clientInfoStore.
  let capturedClient: { name: string; version: string } | undefined;
  s.oninitialized = () => {
    const ci = s.getClientVersion();
    if (ci?.name) capturedClient = { name: ci.name, version: ci.version ?? "" };
  };

  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));
  s.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  s.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
  s.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
  s.setRequestHandler(CallToolRequestSchema, async (req) => {
    const run = async () => {
      const { name, arguments: rawArgs } = req.params;
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      try {
        let r: ToolResult;
        switch (name) {
          case "htmldrop_publish":
            r = await runPublish(args as PublishArgs);
            break;
          case "htmldrop_list":
            r = await runList();
            break;
          case "htmldrop_delete":
            r = await runDelete(args as { id?: string });
            break;
          default:
            throw new Error(`unknown tool: ${name}`);
        }
        return {
          content: [{ type: "text", text: r.text }],
          structuredContent: r.structured,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { isError: true, content: [{ type: "text", text: msg }] };
      }
    };
    if (capturedClient) return clientInfoStore.run(capturedClient, run);
    return run();
  });
  return s;
}

// Auth policy lives in ./auth.ts (parseToken, needsAuth,
// buildWwwAuthenticate, TokenVerdictCache) so it stays unit-testable.
// Preflight validation below keeps OAuth token lifecycle working:
// clients only refresh expired tokens when they see a transport-level
// 401 with error="invalid_token".

// Derived from publicBase, NOT apiBase: hosted deployments point
// HTMLDROP_API_URL at the internal cluster address, and a challenge
// advertising http://…svc.cluster.local is useless to clients (and
// leaks topology). publicBase already handles this via
// HTMLDROP_PUBLIC_URL.
const resourceMetadataUrl = `${publicBase}/.well-known/oauth-protected-resource`;
const verdictCache = new TokenVerdictCache();

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// verifyToken asks the API whether the token is usable. Definite
// verdicts (2xx accept, 401/403 reject) are cached for 60s; network
// failures and 5xx fail OPEN without caching — an introspection
// hiccup must not take down publishing, and the API remains the
// actual enforcement point on every call.
async function verifyToken(token: string): Promise<boolean> {
  const key = hashToken(token);
  const cached = verdictCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const res = await fetch(`${apiBase}/sites`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      verdictCache.set(key, true);
      return true;
    }
    if (res.status === 401 || res.status === 403) {
      verdictCache.set(key, false);
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

// ── transports ─────────────────────────────────────────────────────

const mode = (process.env.HTMLDROP_MCP_MODE ?? "stdio").toLowerCase();

if (mode === "http") {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);

  const httpServer = http.createServer(async (req, res) => {
    try {
      if (req.url === "/healthz" || req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
        return;
      }
      if (!req.url || (!req.url.startsWith("/mcp") && req.url !== "/")) {
        res.writeHead(404, { "Content-Type": "application/json" }).end(
          JSON.stringify({ error: "not_found" }),
        );
        return;
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
          "Access-Control-Max-Age": "86400",
        });
        res.end();
        return;
      }

      res.setHeader("Access-Control-Allow-Origin", "*");

      // Buffer + parse first so the auth policy can see which
      // JSON-RPC method is being called.
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const bodyText = Buffer.concat(chunks).toString("utf8");
      let parsed: unknown = undefined;
      if (bodyText.length > 0) {
        try {
          parsed = JSON.parse(bodyText);
        } catch {
          res
            .writeHead(400, { "Content-Type": "application/json" })
            .end(JSON.stringify({ error: "invalid_json" }));
          return;
        }
      }

      // MCP authorization spec: `initialize` and `tools/list` stay
      // open so directory scanners (Smithery, Anthropic's connector
      // indexer) can probe capabilities anonymously, but protected
      // requests (tools/call) answer 401 with a WWW-Authenticate
      // challenge pointing at the RFC 9728 resource metadata. That
      // challenge is what triggers the OAuth flow in MCP clients —
      // and, with error="invalid_token", their token refresh.
      const token = parseToken(req.headers, req.url ?? "/");
      if (needsAuth(parsed)) {
        if (!token) {
          res
            .writeHead(401, {
              "Content-Type": "application/json",
              "WWW-Authenticate": buildWwwAuthenticate(resourceMetadataUrl),
            })
            .end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        if (!(await verifyToken(token))) {
          res
            .writeHead(401, {
              "Content-Type": "application/json",
              "WWW-Authenticate": buildWwwAuthenticate(resourceMetadataUrl, { invalid: true }),
            })
            .end(JSON.stringify({ error: "invalid_token" }));
          return;
        }
      }

      await tokenStore.run(token, async () => {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        const server = makeServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, parsed);
      });
    } catch (e) {
      process.stderr.write(`http handler error: ${String(e)}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(
          JSON.stringify({ error: "internal_error" }),
        );
      }
    }
  });

  httpServer.listen(port, () => {
    process.stderr.write(`htmldrop-mcp http listening on :${port}\n`);
  });
} else {
  if (!currentToken()) {
    // Agents onboarding a user land here when they pick this package instead
    // of the hosted server, and a bare "token required" line reads as "this
    // product is broken". Name the one-command alternative that needs no
    // token at all, and only then explain the token path this mode wants.
    process.stderr.write(
      [
        "htmldrop-mcp: no API token, so stdio mode cannot start.",
        "",
        "If a browser is available, do not use this package. Use the hosted",
        "server instead — no npm install, no token:",
        "",
        "  claude mcp add --transport http htmldrop https://htmldrop.app/mcp",
        "",
        "Any MCP client: add https://htmldrop.app/mcp as a remote (streamable",
        "HTTP) server. Sign-in happens in the browser on the first tool call.",
        "",
        "This stdio build is for headless/CI use. To use it, create a token at",
        "https://htmldrop.app/dashboard/settings and set HTMLDROP_API_TOKEN.",
        "",
      ].join("\n"),
    );
    process.exit(2);
  }
  const transport = new StdioServerTransport();
  const server = makeServer();
  await server.connect(transport);
}
