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

// v0.3.0 actual ~337 KB → v0.3.1 ~349 KB → v0.3.2 ~407 KB → v0.3.3 ~420 KB
// (CI-measured 430,475 bytes; locally measured 429,993 bytes — pnpm-pack
// output is reproducibly ~482 bytes larger in the GitHub Actions Linux
// runner than on macOS, likely from line-ending or pack-order details).
// v0.3.3 cycle adds AgentOracle captured-response fixture (#87) + ADR-007
// for v0.3.4 K + CHANGELOG growth from the contributor-cohort credit. Bump
// cap to 440 KB for v0.3.3 — same step size as the v0.3.2 cycle's
// 400 → 420 raise. Revisit in v0.3.4 once K/G/I land their `detail.*`
// facets (`upstream_stuck_cause`, `facilitator_fitness`, `reachability`)
// plus the deferred legacy `detail.status` field cleanup on indexing per
// ADR-004's follow-up.
// X402-53 (L) raise 2026-05-29: 440 → 480 KB. v0.3.3 shipped at ~430 KB
// (~10 KB headroom); v0.3.4 adds 4 new facets (host_pollution +
// facilitator_fitness + reachability + upstream_stuck_cause), the new
// `bazaar.host_pollution` event discriminant + diagnose-rules.md +
// facilitator-registry.json across K/G/I/L. 480 KB gives ~30 KB
// headroom for the K + G + I implementation cycle after L lands.
// X402-51 (G) raise 2026-05-29: 480 → 540 KB. K added ~14 KB (verdict
// cause discriminator + AsaiShota contrast fixture + K rule module).
// G adds ~30 KB (facilitator-fitness module + registry JSON + 25 unit
// tests + anchor-x402 multi-rail fixture). 508 KB after G; bumping to
// 540 KB gives ~32 KB headroom for I (probe-history state + 5+ new
// reachability fixtures: NXDOMAIN, TCP refused, TLS error, timeout,
// persistent_5xx, plus the JSONL probe_attempt event discriminant).
const MAX_UNPACKED_BYTES = 540 * 1024;
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
