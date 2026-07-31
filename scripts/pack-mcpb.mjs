// Builds an MCPB (.mcpb) bundle from the compiled MCP server.
//
// An MCPB bundle is a zip file with:
//   manifest.json                 ← MCPB metadata + user_config schema
//   icon.png                      ← optional, surfaced in Claude Desktop's UI
//   server/index.js               ← entry point (path matches manifest.server.entry_point)
//   server/node_modules/**        ← runtime deps (production-only)
//
// Users drag the resulting server.mcpb onto Claude Desktop; Claude
// prompts for user_config (the API token), stores it in the OS
// keychain, and launches the server with the resolved env vars.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = dirname(dirname(fileURLToPath(import.meta.url)));
const stagingDir = join(repoDir, ".mcpb-build");
const distDir = join(repoDir, "dist");
const manifestPath = join(repoDir, "manifest.json");
const iconPath = join(repoDir, "icon.png");
const outFile = join(repoDir, "server.mcpb");

if (!existsSync(distDir)) {
  console.error("dist/ not found — run `npm run build` first.");
  process.exit(1);
}
if (!existsSync(manifestPath)) {
  console.error("manifest.json not found.");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const pkg = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"));

if (manifest.version !== pkg.version) {
  console.error(
    `version mismatch: manifest.json ${manifest.version} vs package.json ${pkg.version}`,
  );
  process.exit(1);
}

console.log(`packing ${manifest.name}@${manifest.version} → server.mcpb`);

// 1. Clean staging
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });
mkdirSync(join(stagingDir, "server"), { recursive: true });

// 2. Copy manifest + (optional) icon
await cp(manifestPath, join(stagingDir, "manifest.json"));
if (existsSync(iconPath)) {
  await cp(iconPath, join(stagingDir, "icon.png"));
}

// 3. Copy the compiled entry point
await cp(distDir, join(stagingDir, "server", "dist"), { recursive: true });

// 4. Drop a tiny entry stub at the path manifest.server.entry_point
//    expects (server/index.js). The stub just re-exports the real
//    server.dist/index.js. This keeps the manifest path stable even
//    if we reshape dist/ later.
writeFileSync(
  join(stagingDir, "server", "index.js"),
  "import('./dist/index.js');\n",
);

// 5. Write a slim package.json declaring production deps + ESM module type
const slim = {
  name: pkg.name,
  version: pkg.version,
  type: "module",
  dependencies: pkg.dependencies,
};
writeFileSync(
  join(stagingDir, "server", "package.json"),
  JSON.stringify(slim, null, 2),
);

// 6. Install production deps inside the bundle.
//    execFileSync with separate args avoids shell-injection risk —
//    inputs here are static literals, but the safe style is the
//    project default.
console.log("installing production deps into bundle…");
execFileSync(
  "npm",
  ["install", "--omit=dev", "--no-audit", "--no-fund", "--silent"],
  { cwd: join(stagingDir, "server"), stdio: "inherit" },
);

// 7. Zip the staging dir → server.mcpb
rmSync(outFile, { force: true });
console.log("zipping bundle…");
execFileSync("zip", ["-r", "-q", outFile, "."], {
  cwd: stagingDir,
  stdio: "inherit",
});

console.log(`wrote ${outFile}`);
