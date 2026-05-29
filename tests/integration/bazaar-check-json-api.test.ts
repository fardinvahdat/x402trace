/**
 * X402-44 — JSON API stability snapshot test.
 *
 * Locks the `bazaar-check --log json` envelope shape against a frozen
 * exemplar in `tests/fixtures/bazaar/json-api-snapshot.json`. Per ADR-004
 * Pillar 2, the JSON output is a documented public API contract;
 * downstream consumers (TomSmart_ai's mapper-integration, future
 * agent-side filters) take a runtime dependency on the shape.
 *
 * What this test catches:
 *   - field RENAMES — fixture says `verdict.kind`, live emits
 *     `verdict.type` → test fails
 *   - field REMOVALS — fixture has `results[3].detail.count`, live drops
 *     it → test fails
 *   - field ADDITIONS — live adds `verdict.severity`, fixture doesn't
 *     have it → test fails
 *   - field REORDERING — top-level keys emit in different order →
 *     stringify check fails
 *
 * **If this test fails and the shape change is intentional:**
 *
 *   1. Verify the new shape is what you want
 *   2. Regenerate this fixture by running:
 *      `pnpm tsx tests/fixtures/bazaar/regenerate-json-api-snapshot.ts`
 *      (or hand-edit the JSON if the test scenario is identical)
 *   3. Add a `### JSON API` subsection to CHANGELOG.md `[Unreleased]`
 *      documenting what changed, plus a stability note (additive vs
 *      shape-breaking — see src/bazaar/json-api.md for the rule)
 *   4. If the change is shape-breaking (rename, removal, type change),
 *      bump the next release as a major version per the rule
 *
 * @see src/bazaar/json-api.md — the contract this test enforces
 * @see DECISIONS.md ADR-004 Pillar 2 — the commitment behind the contract
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runBazaarCheck } from "../../src/bazaar/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = join(__dirname, "..", "fixtures", "bazaar", "json-api-snapshot.json");

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

/**
 * Deterministic fetcher that produces the exact responses needed for
 * the snapshot scenario: well-known returns a clean mcp-discovery
 * manifest, challenge returns a 402 with a matching extensions.bazaar
 * block, discovery returns one resource. No timestamps, no randomness.
 */
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
      // X402-53 (L) — host-pollution queries the merchant endpoint.
      // Deterministic snapshot scenario: single host, no pollution.
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
    // Challenge URL
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

function loadSnapshot(): unknown {
  return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
}

describe("bazaar-check JSON API stability (X402-44, ADR-004 Pillar 2)", () => {
  it("the snapshot fixture is valid JSON", () => {
    expect(() => loadSnapshot()).not.toThrow();
  });

  it("a live bazaar-check run with deterministic mocks deep-equals the snapshot fixture", async () => {
    const snapshot = loadSnapshot();
    const live = await runBazaarCheck({
      serviceUrl: SERVICE,
      chain: "base-sepolia",
      discoveryBaseUrl: TEST_DISCOVERY,
      fetcher: deterministicFetcher(),
    });
    // Round-trip through JSON so the comparison reflects what consumers
    // actually receive (readonly arrays vs plain arrays, undefined-vs-
    // missing-key differences eliminated).
    const liveJson = JSON.parse(JSON.stringify(live));
    expect(liveJson).toEqual(snapshot);
  });

  it("top-level key order is preserved (catches reordering — fragile parsers)", async () => {
    const snapshot = loadSnapshot() as Record<string, unknown>;
    const live = await runBazaarCheck({
      serviceUrl: SERVICE,
      chain: "base-sepolia",
      discoveryBaseUrl: TEST_DISCOVERY,
      fetcher: deterministicFetcher(),
    });
    const liveJson = JSON.parse(JSON.stringify(live)) as Record<string, unknown>;
    expect(Object.keys(liveJson)).toEqual(Object.keys(snapshot));
  });

  it("each result preserves key order (catches per-check shape drift)", async () => {
    const snapshot = loadSnapshot() as {
      results: ReadonlyArray<Record<string, unknown>>;
    };
    const live = await runBazaarCheck({
      serviceUrl: SERVICE,
      chain: "base-sepolia",
      discoveryBaseUrl: TEST_DISCOVERY,
      fetcher: deterministicFetcher(),
    });
    const liveJson = JSON.parse(JSON.stringify(live)) as {
      results: ReadonlyArray<Record<string, unknown>>;
    };
    expect(liveJson.results).toHaveLength(snapshot.results.length);
    for (let i = 0; i < snapshot.results.length; i++) {
      const liveResult = liveJson.results[i];
      const snapshotResult = snapshot.results[i];
      if (liveResult === undefined || snapshotResult === undefined) {
        throw new Error(`results[${i}] missing on one side; length check should have caught this`);
      }
      expect(Object.keys(liveResult)).toEqual(Object.keys(snapshotResult));
    }
  });

  it("the verdict preserves key order per kind (catches verdict discriminator drift)", async () => {
    const snapshot = loadSnapshot() as { verdict: Record<string, unknown> };
    const live = await runBazaarCheck({
      serviceUrl: SERVICE,
      chain: "base-sepolia",
      discoveryBaseUrl: TEST_DISCOVERY,
      fetcher: deterministicFetcher(),
    });
    const liveJson = JSON.parse(JSON.stringify(live)) as { verdict: Record<string, unknown> };
    expect(Object.keys(liveJson.verdict)).toEqual(Object.keys(snapshot.verdict));
    expect(liveJson.verdict["kind"]).toBe(snapshot.verdict["kind"]);
    expect(liveJson.verdict["exitCode"]).toBe(snapshot.verdict["exitCode"]);
  });

  it("all six canonical check names are present in fixed order (catches removal / reordering of a check)", () => {
    const snapshot = loadSnapshot() as {
      results: ReadonlyArray<{ check: string }>;
    };
    const checkNames = snapshot.results.map((r) => r.check);
    // X402-53 (L) — host-pollution appended as 6th check (additive per ADR-008).
    expect(checkNames).toEqual([
      "well-known",
      "challenge",
      "self-payment",
      "indexing",
      "propagation",
      "host-pollution",
    ]);
  });
});
