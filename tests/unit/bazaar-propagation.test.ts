/**
 * X402-45 (D.2) unit tests — metadata propagation diff.
 *
 * Covers the four `metadata_propagation` states (ok / partial /
 * missing / unknown) plus the diff-computation helper + edge cases.
 */
import { describe, expect, it } from "vitest";
import {
  checkPropagation,
  computePropagationStatus,
  type FieldDiff,
} from "../../src/bazaar/propagation.js";

const PAY_TO = "0x1111111111111111111111111111111111111111";
const TEST_DISCOVERY = "https://test-discovery.example.test";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function mockFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return ((url: string) => Promise.resolve(handler(url))) as typeof fetch;
}

const MANIFEST_OK = {
  name: "Snapshot API",
  description: "Frozen exemplar service",
};

describe("computePropagationStatus", () => {
  it("returns ok when diff is empty", () => {
    expect(computePropagationStatus([], 2)).toBe("ok");
  });

  it("returns missing when every diffed manifest value is present and every indexer value is null AND covers all diffed fields", () => {
    const diff: FieldDiff[] = [
      { field: "name", manifest: "X", indexer: null },
      { field: "description", manifest: "Y", indexer: null },
    ];
    expect(computePropagationStatus(diff, 2)).toBe("missing");
  });

  it("returns partial when only some fields drifted (not all manifest-present + indexer-absent)", () => {
    const diff: FieldDiff[] = [{ field: "description", manifest: "Y", indexer: "Y-prime" }];
    expect(computePropagationStatus(diff, 2)).toBe("partial");
  });

  it("returns partial when one field is missing but others match (diff.length < diffedFieldCount)", () => {
    // Only 1 of 2 fields drifted → partial, not missing
    const diff: FieldDiff[] = [{ field: "name", manifest: "X", indexer: null }];
    expect(computePropagationStatus(diff, 2)).toBe("partial");
  });
});

describe("checkPropagation — ok path", () => {
  it("returns status=pass + metadata_propagation=ok when all diffed fields match", async () => {
    const fetcher = mockFetch(() =>
      jsonResponse({
        resources: [{ name: "Snapshot API", description: "Frozen exemplar service" }],
      }),
    );
    const r = await checkPropagation(MANIFEST_OK, PAY_TO, {
      discoveryBaseUrl: TEST_DISCOVERY,
      fetcher,
    });
    expect(r.status).toBe("pass");
    expect(r.detail?.metadata_propagation).toBe("ok");
    expect(r.message).toMatch(/metadata propagation: ok/);
  });
});

describe("checkPropagation — partial path", () => {
  it("returns status=info + metadata_propagation=partial when some fields drift", async () => {
    const fetcher = mockFetch(() =>
      jsonResponse({
        resources: [{ name: "Snapshot API", description: "Different description!" }],
      }),
    );
    const r = await checkPropagation(MANIFEST_OK, PAY_TO, {
      discoveryBaseUrl: TEST_DISCOVERY,
      fetcher,
    });
    expect(r.status).toBe("info");
    expect(r.detail?.metadata_propagation).toBe("partial");
    expect(r.message).toMatch(/partial/);
    const diff = r.detail?.diff as FieldDiff[];
    expect(diff).toHaveLength(1);
    expect(diff[0]?.field).toBe("description");
    expect(r.fix).toMatch(/verify the field values/);
  });
});

describe("checkPropagation — missing path (the @zev / TheRoosters case)", () => {
  it("returns status=info + metadata_propagation=missing when indexer surfaces zero of the manifest's declared fields", async () => {
    const fetcher = mockFetch(() => jsonResponse({ resources: [{}] }));
    const r = await checkPropagation(MANIFEST_OK, PAY_TO, {
      discoveryBaseUrl: TEST_DISCOVERY,
      fetcher,
    });
    expect(r.status).toBe("info");
    expect(r.detail?.metadata_propagation).toBe("missing");
    expect(r.message).toMatch(/missing/);
    expect(r.message).toMatch(/zev|TheRoosters|GM/);
    expect(r.message).toMatch(/#2207/);
    expect(r.fix).toMatch(/upstream Bazaar indexer state/);
  });
});

describe("checkPropagation — unknown path (defensive defaults)", () => {
  it("returns unknown when manifest is undefined (--endpoint mode)", async () => {
    const r = await checkPropagation(undefined, PAY_TO);
    expect(r.status).toBe("pass");
    expect(r.detail?.metadata_propagation).toBe("unknown");
    expect(r.message).toMatch(/no manifest available/);
  });

  it("returns unknown when payTo is undefined", async () => {
    const r = await checkPropagation(MANIFEST_OK, undefined);
    expect(r.status).toBe("pass");
    expect(r.detail?.metadata_propagation).toBe("unknown");
    expect(r.message).toMatch(/no payTo/);
  });

  it("returns unknown when discovery returns non-2xx", async () => {
    const fetcher = mockFetch(() => new Response("error", { status: 503 }));
    const r = await checkPropagation(MANIFEST_OK, PAY_TO, {
      discoveryBaseUrl: TEST_DISCOVERY,
      fetcher,
    });
    expect(r.status).toBe("pass");
    expect(r.detail?.metadata_propagation).toBe("unknown");
    expect(r.message).toMatch(/HTTP 503/);
  });

  it("returns unknown when discovery returns empty resources array (service not indexed yet)", async () => {
    const fetcher = mockFetch(() => jsonResponse({ resources: [] }));
    const r = await checkPropagation(MANIFEST_OK, PAY_TO, {
      discoveryBaseUrl: TEST_DISCOVERY,
      fetcher,
    });
    expect(r.status).toBe("pass");
    expect(r.detail?.metadata_propagation).toBe("unknown");
    expect(r.message).toMatch(/not indexed yet/);
  });

  it("returns unknown when fetcher throws (network error)", async () => {
    const fetcher = ((_url: string) =>
      Promise.reject(new Error("DNS lookup failed"))) as typeof fetch;
    const r = await checkPropagation(MANIFEST_OK, PAY_TO, {
      discoveryBaseUrl: TEST_DISCOVERY,
      fetcher,
    });
    expect(r.status).toBe("pass");
    expect(r.detail?.metadata_propagation).toBe("unknown");
    expect(r.message).toMatch(/DNS lookup failed/);
  });

  it("returns unknown when discovery returns non-JSON body", async () => {
    const fetcher = mockFetch(() => new Response("<html>oops</html>", { status: 200 }));
    const r = await checkPropagation(MANIFEST_OK, PAY_TO, {
      discoveryBaseUrl: TEST_DISCOVERY,
      fetcher,
    });
    expect(r.status).toBe("pass");
    expect(r.detail?.metadata_propagation).toBe("unknown");
    expect(r.message).toMatch(/non-JSON/);
  });
});

describe("checkPropagation — not_applicable_non_cdp (X402-46 / ADR-004 Pillar 3)", () => {
  it("short-circuits to not_applicable_non_cdp when manifest declares non-CDP facilitator", async () => {
    // Fetcher should NOT be called — short-circuit fires before the network probe.
    let fetcherCalled = false;
    const fetcher = mockFetch(() => {
      fetcherCalled = true;
      return jsonResponse({ resources: [] });
    });
    const r = await checkPropagation(
      {
        name: "X",
        description: "Y",
        extensions: { bazaar: { facilitator: "x402-rs" } },
      },
      PAY_TO,
      { discoveryBaseUrl: TEST_DISCOVERY, fetcher },
    );
    expect(r.status).toBe("pass");
    expect(r.detail?.metadata_propagation).toBe("not_applicable_non_cdp");
    expect(r.message).toMatch(/not applicable|non-CDP|ADR-004 Pillar 3/);
    expect(fetcherCalled).toBe(false);
  });

  it("does NOT short-circuit when manifest declares CDP — proceeds with diff", async () => {
    const fetcher = mockFetch(() =>
      jsonResponse({
        resources: [{ name: "X", description: "Y" }],
      }),
    );
    const r = await checkPropagation(
      {
        name: "X",
        description: "Y",
        extensions: { bazaar: { facilitator: "coinbase-cdp" } },
      },
      PAY_TO,
      { discoveryBaseUrl: TEST_DISCOVERY, fetcher },
    );
    expect(r.detail?.metadata_propagation).toBe("ok");
  });
});

describe("checkPropagation — edge cases", () => {
  it("treats whitespace-only manifest values as missing (matches well-known's trim() semantics)", async () => {
    const manifestWithWhitespace = { name: "   ", description: "ok" };
    const fetcher = mockFetch(() =>
      jsonResponse({ resources: [{ name: "X", description: "ok" }] }),
    );
    const r = await checkPropagation(manifestWithWhitespace, PAY_TO, {
      discoveryBaseUrl: TEST_DISCOVERY,
      fetcher,
    });
    // Manifest name=whitespace → null; indexer name="X" → "X". They
    // differ → diff entry. Description matches → not in diff. Result
    // is partial (1 of 2 fields drifted).
    expect(r.detail?.metadata_propagation).toBe("partial");
  });

  it("uses only the first resource when discovery returns multiple", async () => {
    const fetcher = mockFetch(() =>
      jsonResponse({
        resources: [
          { name: "Snapshot API", description: "Frozen exemplar service" },
          { name: "Different second resource", description: "ignored" },
        ],
      }),
    );
    const r = await checkPropagation(MANIFEST_OK, PAY_TO, {
      discoveryBaseUrl: TEST_DISCOVERY,
      fetcher,
    });
    // First resource matches; result is ok despite second resource drifting
    expect(r.detail?.metadata_propagation).toBe("ok");
  });
});
