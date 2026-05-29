/**
 * X402-47 — captured-response fixture consumption.
 *
 * Iterates over every fixture in
 * `tests/fixtures/bazaar/captured-responses/` and runs the full
 * `runBazaarCheck` pipeline against the captured responses. Each
 * fixture is self-describing — see that directory's README for the
 * schema.
 *
 * What this gets us:
 *
 *   - End-to-end coverage of the v0.3.2 D.x verdict-synthesis paths
 *     (D.2 missing propagation, D.3 processing-stuck → upstream_stuck,
 *     D.5 body-discovery → no false-positive)
 *   - Hermetic — no live HTTP, no service-up dependencies
 *   - Extensible — adding a fixture is one JSON file; the harness
 *     auto-picks it up
 *
 * When real contributor fixtures arrive (TomSmart Sun drop, AsaiShota
 * test-echo-cdp capture, etc.) they wire in alongside the synthetic
 * ones here OR into `production-set/` for structural assertion.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runBazaarCheck } from "../../src/bazaar/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "..", "fixtures", "bazaar", "captured-responses");

interface CapturedResponseFixture {
  readonly $comment?: string;
  readonly scenario: string;
  readonly input: {
    readonly serviceUrl: string;
    readonly chain: "base-sepolia" | "base";
  };
  readonly mocks: {
    readonly "well-known": { readonly status: number; readonly body: unknown };
    readonly challenge: { readonly status: number; readonly body: unknown };
    readonly discovery: { readonly status: number; readonly body: unknown };
    /**
     * X402-53 (L) — optional mock for the CDP merchant discovery
     * endpoint queried by `checkHostPollution`. When absent, the
     * `discovery` mock is reused as fallback; existing fixtures stay
     * unchanged because the host-pollution check tolerates non-resources
     * bodies as `unknown` state.
     */
    readonly "discovery-merchant"?: { readonly status: number; readonly body: unknown };
    /**
     * X402-50 (K, ADR-007) — optional buyer-side payment-payload capture
     * fed into the K rules via `BazaarCheckOptions.paymentPayloadCapture`.
     * Fixtures wanting to assert `upstream_stuck_cause: payload_echo_gap`
     * via Rule 1 (`payment_payload_missing_resource_object`) supply a
     * payload here whose `resource` is a bare URL string. Absence ⇒
     * Rule 1 defers; existing fixtures retain their pre-K verdicts.
     */
    readonly paymentPayload?: { readonly paymentPayload: Record<string, unknown> };
    /**
     * X402-50 (K, ADR-007) — optional /settle response capture fed into
     * Rule 2 (`extensions_not_echoed`). Headers map uses lowercased keys.
     */
    readonly settle?: {
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
    };
  };
  readonly expected: {
    readonly verdict:
      | "looks_correct"
      | "implementation_issue"
      | "upstream_issue"
      | "upstream_stuck";
    readonly exitCode: 0 | 2 | 3;
    readonly facets?: Readonly<Record<string, unknown>>;
    /** X402-50 (K) — optional `verdict.cause` assertion when `upstream_stuck`. */
    readonly verdictCause?:
      | "payload_echo_gap"
      | "indexer_state_processing"
      | "indexer_state_terminal"
      | "unknown";
  };
}

function loadFixtures(): Array<{ filename: string; fixture: CapturedResponseFixture }> {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((filename) => ({
      filename,
      fixture: JSON.parse(
        readFileSync(join(FIXTURE_DIR, filename), "utf8"),
      ) as CapturedResponseFixture,
    }));
}

/**
 * Build a fetcher that dispatches the three URLs (well-known, challenge,
 * discovery) per the fixture's `mocks` block.
 */
function fixtureFetcher(fixture: CapturedResponseFixture): typeof fetch {
  return ((urlInput: string) => {
    const url = String(urlInput);
    let mock: { status: number; body: unknown };
    if (url.endsWith("/.well-known/x402")) {
      mock = fixture.mocks["well-known"];
    } else if (url.includes("discovery/merchant")) {
      // X402-53 (L) — host-pollution check queries the merchant discovery
      // endpoint. Fall back to the `discovery` mock when a fixture predates
      // X402-53 and doesn't supply a separate `discovery-merchant` mock;
      // the host-pollution check tolerates non-resources bodies as `unknown`.
      mock = fixture.mocks["discovery-merchant"] ?? fixture.mocks["discovery"];
    } else if (url.includes("discovery/resources")) {
      mock = fixture.mocks["discovery"];
    } else {
      mock = fixture.mocks["challenge"];
    }
    return Promise.resolve(
      new Response(JSON.stringify(mock.body), {
        status: mock.status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

/**
 * Extract a per-check `detail` facet by dotted path: `<check>.<facet>`.
 * Example: `"indexing.indexer_state"` → finds the indexing result, then
 * reads `detail.indexer_state`.
 */
function extractFacet(
  results: ReadonlyArray<{ check: string; detail?: Record<string, unknown> }>,
  path: string,
): unknown {
  const [checkName, facetKey] = path.split(".");
  const result = results.find((r) => r.check === checkName);
  return result?.detail?.[facetKey ?? ""];
}

describe("bazaar-check captured-response fixtures (X402-47)", () => {
  const fixtures = loadFixtures();

  it("the fixture directory contains at least one fixture", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  describe.each(fixtures)("$filename", ({ filename, fixture }) => {
    function runFixture() {
      return runBazaarCheck({
        serviceUrl: fixture.input.serviceUrl,
        chain: fixture.input.chain,
        fetcher: fixtureFetcher(fixture),
        // X402-50 (K) — optional K-rule capture inputs from the fixture mocks.
        ...(fixture.mocks.paymentPayload !== undefined
          ? { paymentPayloadCapture: fixture.mocks.paymentPayload }
          : {}),
        ...(fixture.mocks.settle !== undefined ? { settleCapture: fixture.mocks.settle } : {}),
      });
    }

    it("produces the expected verdict + exit code", async () => {
      const report = await runFixture();
      expect(report.verdict.kind).toBe(fixture.expected.verdict);
      expect(report.verdict.exitCode).toBe(fixture.expected.exitCode);
    });

    if (fixture.expected.verdictCause !== undefined) {
      it(`verdict.cause = ${fixture.expected.verdictCause} (X402-50 K)`, async () => {
        const report = await runFixture();
        // verdict.cause is only present on the upstream_stuck variant.
        if (report.verdict.kind !== "upstream_stuck") {
          throw new Error(
            `fixture asserts verdict.cause but verdict.kind is ${report.verdict.kind}; verdict.cause only applies to upstream_stuck`,
          );
        }
        expect(report.verdict.cause).toBe(fixture.expected.verdictCause);
      });
    }

    if (fixture.expected.facets) {
      const facetEntries = Object.entries(fixture.expected.facets);
      it.each(facetEntries)(`facet %s matches`, async (path, expected) => {
        const report = await runFixture();
        const actual = extractFacet(report.results, path);
        expect(actual).toEqual(expected);
      });
    }

    it("the fixture file conforms to the schema (has scenario, input, mocks, expected)", () => {
      expect(fixture.scenario).toBeTypeOf("string");
      expect(fixture.scenario).toBe(filename.replace(/\.json$/, ""));
      expect(fixture.input.serviceUrl).toBeTypeOf("string");
      expect(fixture.mocks["well-known"]).toBeDefined();
      expect(fixture.mocks["challenge"]).toBeDefined();
      expect(fixture.mocks["discovery"]).toBeDefined();
      expect([
        "looks_correct",
        "implementation_issue",
        "upstream_issue",
        "upstream_stuck",
      ]).toContain(fixture.expected.verdict);
    });
  });
});
