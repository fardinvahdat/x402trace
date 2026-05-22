#!/usr/bin/env node
/**
 * Publish-surface guard. Two checks run against the built `dist/`:
 *
 *   1. Bundle size cap — `npm pack --dry-run --json` must report fewer
 *      than MAX_FILES entries and less than MAX_UNPACKED_BYTES unpacked.
 *      Catches accidental scope expansion (someone widening
 *      `tsconfig.build.json` or `package.json#files`).
 *
 *   2. devDependency import check — no file in `dist/` may import a
 *      package listed in `package.json#devDependencies`. Catches the
 *      v0.2.2 mistake (`hono`/`x402-fetch`/`x402-hono` classified as
 *      runtime deps for code that never shipped) coming back.
 *
 * Run locally with `pnpm build && node scripts/check-publish-surface.mjs`.
 * Wired into CI in `.github/workflows/ci.yml`.
 */

import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

// v0.3.0 actual ~337 KB → v0.3.1 ~349 KB → v0.3.2 ~407 KB. v0.3.2 cycle adds
// six new dist/ modules (D.2 propagation, D.3 facilitator-detect, D.5
// extensions-bazaar, src/bazaar/json-api.md shipped in dist) plus a fatter
// CHANGELOG.md (which is in `files` and therefore part of the unpacked
// surface). Bump the cap to 420 KB for v0.3.2; revisit in v0.3.3 when the
// next surface cleanup happens (extracting the legacy `detail.status` field
// on indexing per ADR-004's deferred follow-up).
const MAX_UNPACKED_BYTES = 420 * 1024;
// v0.3.0: 96 → v0.3.1 + PR #69 fixtures: 100 → v0.3.2 cycle adds (json-api
// stability + D.5 extensions-bazaar + D.2 propagation + D.3 facilitator-
// detect): 102. Raised to 110 with breathing room for X402-47 fixture
// consumption + future v0.3.x facets. Reduce again when the next major
// surface cleanup happens (e.g., extracting the legacy `detail.status`
// field on indexing).
const MAX_FILES = 110;
const DIST_DIR = "dist";

if (!existsSync(DIST_DIR)) {
  console.error(`✗ ${DIST_DIR}/ not found. Run \`pnpm build\` first.`);
  process.exit(1);
}

const failures = [];

const packJson = execSync("npm pack --dry-run --json", { encoding: "utf8" });
const pack = JSON.parse(packJson)[0];

if (pack.unpackedSize > MAX_UNPACKED_BYTES) {
  failures.push(
    `bundle unpacked size ${pack.unpackedSize} bytes exceeds cap ${MAX_UNPACKED_BYTES} bytes`,
  );
}
if (pack.entryCount > MAX_FILES) {
  failures.push(`bundle file count ${pack.entryCount} exceeds cap ${MAX_FILES}`);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const devDeps = Object.keys(pkg.devDependencies ?? {});

const sourceFiles = walk(DIST_DIR).filter(
  (f) => f.endsWith(".js") || f.endsWith(".mjs") || f.endsWith(".cjs") || f.endsWith(".d.ts"),
);

const violations = [];
for (const file of sourceFiles) {
  const content = readFileSync(file, "utf8");
  for (const dep of devDeps) {
    const escaped = dep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:from|require\\(|import\\()\\s*['"\`]${escaped}(['"\`/])`);
    if (pattern.test(content)) {
      violations.push({ file, dep });
    }
  }
}

if (violations.length > 0) {
  failures.push(
    `dist/ imports ${violations.length} devDependenc${violations.length === 1 ? "y" : "ies"}:\n` +
      violations.map((v) => `    ${v.file} → ${v.dep}`).join("\n"),
  );
}

if (failures.length > 0) {
  for (const f of failures) {
    console.error(`✗ ${f}`);
  }
  process.exit(1);
}

console.log(
  `✓ Publish surface OK: ${pack.entryCount} files, ${pack.unpackedSize} bytes unpacked, 0 devDep imports`,
);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
