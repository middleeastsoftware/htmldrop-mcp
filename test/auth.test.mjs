// Tests for the HTTP-mode auth policy (mcp/src/auth.ts).
// Run: npm test (builds first; tests import from dist/).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseToken,
  needsAuth,
  buildWwwAuthenticate,
  TokenVerdictCache,
} from "../dist/auth.js";

// ── parseToken ─────────────────────────────────────────────────────

test("parseToken: standard RFC 6750 bearer header", () => {
  assert.equal(parseToken({ authorization: "Bearer hsk_live_abc" }, "/mcp"), "hsk_live_abc");
});

test("parseToken: Smithery parameter-as-header aliases still work", () => {
  assert.equal(parseToken({ apitoken: "t1" }, "/mcp"), "t1");
  assert.equal(parseToken({ "x-api-token": "t2" }, "/mcp"), "t2");
});

test("parseToken: query-string tokens are NOT accepted (spec forbids)", () => {
  assert.equal(parseToken({}, "/mcp?apiToken=leaky"), "");
  assert.equal(parseToken({}, "/mcp?api_token=leaky"), "");
});

test("parseToken: bearer header wins over aliases", () => {
  assert.equal(parseToken({ authorization: "Bearer real", apitoken: "alias" }, "/mcp"), "real");
});

// ── needsAuth ──────────────────────────────────────────────────────

test("needsAuth: initialize and tools/list stay open for scanners", () => {
  assert.equal(needsAuth({ jsonrpc: "2.0", method: "initialize", id: 1 }), false);
  assert.equal(needsAuth({ jsonrpc: "2.0", method: "tools/list", id: 2 }), false);
});

test("needsAuth: tools/call is protected", () => {
  assert.equal(
    needsAuth({ jsonrpc: "2.0", method: "tools/call", id: 3, params: { name: "htmldrop_publish" } }),
    true,
  );
});

test("needsAuth: batch containing a tools/call is protected", () => {
  assert.equal(
    needsAuth([
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
      { jsonrpc: "2.0", method: "tools/call", id: 2, params: { name: "htmldrop_list" } },
    ]),
    true,
  );
});

test("needsAuth: notifications and malformed bodies are not protected", () => {
  assert.equal(needsAuth({ jsonrpc: "2.0", method: "notifications/initialized" }), false);
  assert.equal(needsAuth(undefined), false);
  assert.equal(needsAuth("nonsense"), false);
});

// ── buildWwwAuthenticate ───────────────────────────────────────────

test("buildWwwAuthenticate: missing credentials — no error param per RFC 6750 §3.1", () => {
  const h = buildWwwAuthenticate("https://htmldrop.app/.well-known/oauth-protected-resource");
  assert.equal(
    h,
    'Bearer resource_metadata="https://htmldrop.app/.well-known/oauth-protected-resource", scope="mcp"',
  );
});

test("buildWwwAuthenticate: invalid token adds error=invalid_token", () => {
  const h = buildWwwAuthenticate("https://htmldrop.app/.well-known/oauth-protected-resource", {
    invalid: true,
  });
  assert.ok(h.includes('error="invalid_token"'));
  assert.ok(h.includes('resource_metadata="https://htmldrop.app/.well-known/oauth-protected-resource"'));
});

// ── TokenVerdictCache ──────────────────────────────────────────────

test("TokenVerdictCache: caches verdicts within TTL, expires after", async () => {
  let now = 1000;
  const cache = new TokenVerdictCache({ ttlMs: 60_000, maxEntries: 4, clock: () => now });
  assert.equal(cache.get("tok"), undefined);
  cache.set("tok", true);
  assert.equal(cache.get("tok"), true);
  now += 59_000;
  assert.equal(cache.get("tok"), true);
  now += 2_000;
  assert.equal(cache.get("tok"), undefined);
});

test("TokenVerdictCache: evicts oldest beyond maxEntries", () => {
  const cache = new TokenVerdictCache({ ttlMs: 60_000, maxEntries: 2, clock: () => 1 });
  cache.set("a", true);
  cache.set("b", false);
  cache.set("c", true);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), false);
  assert.equal(cache.get("c"), true);
});
