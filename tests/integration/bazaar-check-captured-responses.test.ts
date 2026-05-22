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
  };
  readonly expected: {
    readonly verdict:
      | "looks_correct"
      | "implementation_issue"
      | "upstream_issue"
      | "upstream_stuck";
    readonly exitCode: 0 | 2 | 3;
    readonly facets?: Readonly<Record<string, unknown>>;
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
    const mock = url.endsWith("/.well-known/x402")
      ? fixture.mocks["well-known"]
      : url.includes("discovery/resources")
        ? fixture.mocks["discovery"]
        : fixture.mocks["challenge"];
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
    it("produces the expected verdict + exit code", async () => {
      const report = await runBazaarCheck({
        serviceUrl: fixture.input.serviceUrl,
        chain: fixture.input.chain,
        fetcher: fixtureFetcher(fixture),
      });

      expect(report.verdict.kind).toBe(fixture.expected.verdict);
      expect(report.verdict.exitCode).toBe(fixture.expected.exitCode);
    });

    if (fixture.expected.facets) {
      const facetEntries = Object.entries(fixture.expected.facets);
      it.each(facetEntries)(`facet %s matches`, async (path, expected) => {
        const report = await runBazaarCheck({
          serviceUrl: fixture.input.serviceUrl,
          chain: fixture.input.chain,
          fetcher: fixtureFetcher(fixture),
        });
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
