/**
 * Regenerates `tests/fixtures/bazaar/json-api-snapshot.json` from the
 * live `runBazaarCheck` output against the deterministic fetcher used
 * by `tests/integration/bazaar-check-json-api.test.ts`.
 *
 * Run:
 *   pnpm tsx tests/fixtures/bazaar/regenerate-json-api-snapshot.ts
 *
 * Use this when:
 *   - A new check is added to `runBazaarCheck` (additive — appends to results)
 *   - An existing check's detail shape changes additively
 *   - The verdict shape changes additively
 *
 * Per ADR-004 Pillar 2 + X402-44: regenerating the snapshot is the
 * normal path for additive shape changes. Shape-breaking changes
 * (rename, removal, type change) require a major version bump per
 * `src/bazaar/json-api.md`.
 *
 * Keep the deterministic fetcher here in lockstep with the one in
 * `tests/integration/bazaar-check-json-api.test.ts`.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runBazaarCheck } from "../../../src/bazaar/index.js";

const SERVICE = "https://api.example.test/api/snapshot";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const TEST_DISCOVERY = "https://test-discovery.example.test";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function deterministicFetcher(): typeof fetch {
  return ((urlInput: string) => {
    const url = String(urlInput);
    if (url.endsWith("/.well-known/x402")) {
      return Promise.resolve(
        jsonResponse({
          name: "Snapshot API",
          description: "Frozen exemplar for ADR-004 Pillar 2",
          accepts: [],
          extensions: {
            bazaar: {
              name: "Snapshot API",
              description: "Frozen exemplar for ADR-004 Pillar 2",
            },
          },
        }),
      );
    }
    if (url.includes("discovery/merchant")) {
      // X402-53 (L) — host-pollution: single host, no pollution.
      return Promise.resolve(
        jsonResponse({
          pagination: { limit: 50, offset: 0, total: 1 },
          payTo: PAY_TO,
          resources: [{ resource: SERVICE }],
        }),
      );
    }
    if (url.includes("discovery/resources")) {
      return Promise.resolve(
        jsonResponse({
          resources: [
            {
              name: "Snapshot API",
              description: "Frozen exemplar for ADR-004 Pillar 2",
            },
          ],
        }),
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          x402Version: 1,
          accepts: [
            {
              scheme: "exact",
              network: "base-sepolia",
              maxAmountRequired: "1000",
              resource: SERVICE,
              payTo: PAY_TO,
              asset: USDC,
              maxTimeoutSeconds: 300,
            },
          ],
          extensions: {
            bazaar: {
              name: "Snapshot API",
              description: "Frozen exemplar for ADR-004 Pillar 2",
            },
          },
        }),
        { status: 402, headers: { "content-type": "application/json" } },
      ),
    );
  }) as typeof fetch;
}

async function main(): Promise<void> {
  const live = await runBazaarCheck({
    serviceUrl: SERVICE,
    chain: "base-sepolia",
    discoveryBaseUrl: TEST_DISCOVERY,
    fetcher: deterministicFetcher(),
  });
  // Round-trip through JSON to drop undefined-vs-missing-key differences.
  const json = JSON.parse(JSON.stringify(live));
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const out = join(__dirname, "json-api-snapshot.json");
  writeFileSync(out, JSON.stringify(json, null, 2) + "\n");
  console.log(`snapshot regenerated → ${out}`);
  console.log(`  results length: ${live.results.length}`);
  console.log(`  verdict kind:   ${live.verdict.kind}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
