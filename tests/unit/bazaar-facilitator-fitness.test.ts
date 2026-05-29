/**
 * X402-51 (v0.3.4 G, ADR-005) — facilitator-fitness check unit tests.
 *
 * Covers:
 *   - `loadFacilitatorRegistry` returns the built-in 3-entry registry
 *   - `resolveFacilitator` name + URL matching (case-insensitive, prefix-tolerant)
 *   - `probeFacilitatorWithRetry` classification: ok / degraded / unreachable / 4xx-as-ok
 *   - `checkFacilitatorFitness` happy paths (CDP / PayAI declared + probe success)
 *   - `checkFacilitatorFitness` no-facilitator-declared → all unknown
 *   - `checkFacilitatorFitness` unknown-facilitator → all unknown (no probe attempted)
 *   - `checkFacilitatorFitness` unreachable rail → status info (verdict info-signal)
 *   - Multi-rail emission (3 accepts → 3 entries)
 *   - Edge cases: empty accepts[], malformed network, missing extensions.bazaar
 */

import { describe, expect, it } from "vitest";
import {
  checkFacilitatorFitness,
  loadFacilitatorRegistry,
  probeFacilitatorWithRetry,
  resolveFacilitator,
} from "../../src/bazaar/facilitator-fitness.js";
import type { WellKnownManifest } from "../../src/bazaar/types.js";

const MULTI_RAIL_MANIFEST: WellKnownManifest = {
  name: "anchor-x402",
  description: "multi-rail attestation",
  accepts: [
    { scheme: "exact", network: "eip155:8453", payTo: "0x127462" },
    { scheme: "exact", network: "solana:5eykt4Us", payTo: "6apuZv" },
    { scheme: "exact", network: "eip155:137", payTo: "0x127462" },
  ],
  extensions: {
    bazaar: { name: "anchor-x402", description: "multi-rail", facilitator: "cdp" },
  },
};

describe("loadFacilitatorRegistry", () => {
  it("returns a non-empty built-in registry", () => {
    const registry = loadFacilitatorRegistry();
    expect(registry.version).toBe(1);
    expect(registry.facilitators.length).toBeGreaterThanOrEqual(3);
  });

  it("includes the three v0.3.4 anchors: CDP, PayAI, x402.org", () => {
    const registry = loadFacilitatorRegistry();
    const ids = registry.facilitators.map((f) => f.id);
    expect(ids).toContain("cdp");
    expect(ids).toContain("payai");
    expect(ids).toContain("x402-org");
  });

  it("every entry has a probe_endpoint", () => {
    const registry = loadFacilitatorRegistry();
    for (const f of registry.facilitators) {
      expect(typeof f.probe_endpoint).toBe("string");
      expect(f.probe_endpoint).toMatch(/^https?:\/\//);
    }
  });
});

describe("resolveFacilitator", () => {
  it("matches by short name (case-insensitive)", () => {
    expect(resolveFacilitator("cdp")?.id).toBe("cdp");
    expect(resolveFacilitator("CDP")?.id).toBe("cdp");
    expect(resolveFacilitator("Coinbase-CDP")?.id).toBe("cdp");
    expect(resolveFacilitator("coinbase")?.id).toBe("cdp");
    expect(resolveFacilitator("payai")?.id).toBe("payai");
    expect(resolveFacilitator("PayAI")?.id).toBe("payai");
  });

  it("matches by declared URL (exact)", () => {
    expect(resolveFacilitator("https://api.cdp.coinbase.com")?.id).toBe("cdp");
    expect(resolveFacilitator("https://facilitator.payai.network")?.id).toBe("payai");
  });

  it("matches by declared URL prefix", () => {
    expect(resolveFacilitator("https://api.cdp.coinbase.com/platform/v2/x402")?.id).toBe("cdp");
    expect(resolveFacilitator("https://facilitator.payai.network/x402/verify")?.id).toBe("payai");
  });

  it("returns null for unknown facilitator", () => {
    expect(resolveFacilitator("https://unknown.example.com")).toBeNull();
    expect(resolveFacilitator("not-a-registered-name")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(resolveFacilitator("")).toBeNull();
    expect(resolveFacilitator("   ")).toBeNull();
  });
});

describe("probeFacilitatorWithRetry", () => {
  it("returns ok on first-attempt 2xx", async () => {
    const fetcher = (() =>
      Promise.resolve(
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      )) as typeof fetch;
    const result = await probeFacilitatorWithRetry("https://example/verify", fetcher);
    expect(result.fitness).toBe("ok");
    expect(result.diagnostic).toContain("2xx");
  });

  it("returns ok on 4xx (facilitator responsive, probe-payload rejection is expected)", async () => {
    const fetcher = (() =>
      Promise.resolve(new Response("bad payload", { status: 400 }))) as typeof fetch;
    const result = await probeFacilitatorWithRetry("https://example/verify", fetcher);
    expect(result.fitness).toBe("ok");
    expect(result.diagnostic).toContain("400");
  });

  it("returns degraded when 5xx recovers on retry", async () => {
    let attempt = 0;
    const fetcher = (() => {
      attempt++;
      if (attempt < 2) {
        return Promise.resolve(new Response("", { status: 500 }));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch;
    const result = await probeFacilitatorWithRetry("https://example/verify", fetcher, {
      retryDelays: [10, 10, 10],
    });
    expect(result.fitness).toBe("degraded");
    expect(result.diagnostic).toContain("recovered");
  });

  it("returns unreachable when all attempts return 5xx", async () => {
    const fetcher = (() => Promise.resolve(new Response("", { status: 503 }))) as typeof fetch;
    const result = await probeFacilitatorWithRetry("https://example/verify", fetcher, {
      retryDelays: [10, 10, 10],
    });
    expect(result.fitness).toBe("unreachable");
    expect(result.diagnostic).toContain("HTTP 503");
  });

  it("returns unreachable when all attempts throw (network errors)", async () => {
    const fetcher = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
    const result = await probeFacilitatorWithRetry("https://example/verify", fetcher, {
      retryDelays: [10, 10, 10],
    });
    expect(result.fitness).toBe("unreachable");
    expect(result.diagnostic).toContain("ECONNREFUSED");
  });

  it("respects custom retry delays count (zero retries = single attempt)", async () => {
    let calls = 0;
    const fetcher = (() => {
      calls++;
      return Promise.resolve(new Response("", { status: 500 }));
    }) as typeof fetch;
    await probeFacilitatorWithRetry("https://example/verify", fetcher, { retryDelays: [] });
    expect(calls).toBe(1);
  });
});

describe("checkFacilitatorFitness — no facilitator declared", () => {
  it("emits all rails with fitness: unknown when manifest absent", async () => {
    const result = await checkFacilitatorFitness(undefined);
    expect(result.status).toBe("pass");
    const facet = result.detail?.["facilitator_fitness"] as {
      rails: Array<{ fitness: string; identity_source: string }>;
    };
    expect(facet.rails.length).toBe(1); // single placeholder rail
    expect(facet.rails[0]!.fitness).toBe("unknown");
    expect(facet.rails[0]!.identity_source).toBe("unknown");
  });

  it("emits unknown when manifest has no extensions.bazaar.facilitator field", async () => {
    const manifest: WellKnownManifest = {
      name: "x",
      accepts: [{ network: "eip155:8453" }],
      extensions: { bazaar: { name: "x", description: "y" } },
    };
    const result = await checkFacilitatorFitness(manifest);
    expect(result.status).toBe("pass");
    const facet = result.detail?.["facilitator_fitness"] as {
      rails: Array<{ fitness: string; identity_source: string }>;
    };
    expect(facet.rails[0]!.fitness).toBe("unknown");
    expect(facet.rails[0]!.identity_source).toBe("unknown");
  });
});

describe("checkFacilitatorFitness — unknown facilitator (declared but not in registry)", () => {
  it("emits unknown without attempting any probe", async () => {
    let probeAttempts = 0;
    const fetcher = (() => {
      probeAttempts++;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch;
    const manifest: WellKnownManifest = {
      accepts: [{ network: "eip155:8453" }],
      extensions: { bazaar: { facilitator: "https://unknown-facilitator.example" } },
    };
    const result = await checkFacilitatorFitness(manifest, { fetcher });
    expect(result.status).toBe("pass");
    expect(probeAttempts).toBe(0);
    expect(result.message).toContain("not in built-in registry");
    const facet = result.detail?.["facilitator_fitness"] as {
      rails: Array<{ fitness: string; identity_source: string }>;
    };
    expect(facet.rails[0]!.fitness).toBe("unknown");
    expect(facet.rails[0]!.identity_source).toBe("declared");
  });
});

describe("checkFacilitatorFitness — CDP declared, healthy probe", () => {
  it("emits ok across all 3 rails when probe returns 2xx", async () => {
    const fetcher = (() => Promise.resolve(new Response("{}", { status: 200 }))) as typeof fetch;
    const result = await checkFacilitatorFitness(MULTI_RAIL_MANIFEST, { fetcher });
    expect(result.status).toBe("pass");
    const facet = result.detail?.["facilitator_fitness"] as {
      rails: Array<{ rail: number; network: string; fitness: string }>;
      summary: { ok: number; degraded: number; unreachable: number; unknown: number };
    };
    expect(facet.rails.length).toBe(3);
    expect(facet.summary.ok).toBe(3);
    expect(facet.summary.unreachable).toBe(0);
    expect(facet.rails.map((r) => r.network)).toEqual([
      "eip155:8453",
      "solana:5eykt4Us",
      "eip155:137",
    ]);
    expect(facet.rails.every((r) => r.fitness === "ok")).toBe(true);
  });

  it("probes only ONCE for shared-facilitator multi-rail (no per-rail HTTP)", async () => {
    let probeCount = 0;
    const fetcher = (() => {
      probeCount++;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch;
    await checkFacilitatorFitness(MULTI_RAIL_MANIFEST, { fetcher });
    expect(probeCount).toBe(1);
  });
});

describe("checkFacilitatorFitness — unreachable facilitator → status info", () => {
  it("flips to status info when all rails are unreachable", async () => {
    const fetcher = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
    const result = await checkFacilitatorFitness(MULTI_RAIL_MANIFEST, {
      fetcher,
      retryDelays: [10, 10, 10],
    });
    expect(result.status).toBe("info");
    expect(result.fix).toContain("facilitator");
    const facet = result.detail?.["facilitator_fitness"] as {
      rails: Array<{ fitness: string }>;
      summary: { unreachable: number };
    };
    expect(facet.summary.unreachable).toBe(3);
    expect(facet.rails.every((r) => r.fitness === "unreachable")).toBe(true);
  });
});

describe("checkFacilitatorFitness — degraded recovery → status pass (facet only)", () => {
  it("emits degraded rails without flipping verdict", async () => {
    let attempt = 0;
    const fetcher = (() => {
      attempt++;
      if (attempt < 2) {
        return Promise.resolve(new Response("", { status: 502 }));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch;
    const result = await checkFacilitatorFitness(MULTI_RAIL_MANIFEST, {
      fetcher,
      retryDelays: [10, 10, 10],
    });
    expect(result.status).toBe("pass"); // degraded does not flip verdict
    const facet = result.detail?.["facilitator_fitness"] as {
      summary: { degraded: number; ok: number };
    };
    expect(facet.summary.degraded).toBe(3);
    expect(facet.summary.ok).toBe(0);
  });
});

describe("checkFacilitatorFitness — edge cases", () => {
  it("handles manifest with empty accepts[] (emits single placeholder rail)", async () => {
    const fetcher = (() => Promise.resolve(new Response("{}", { status: 200 }))) as typeof fetch;
    const manifest: WellKnownManifest = {
      accepts: [],
      extensions: { bazaar: { facilitator: "cdp" } },
    };
    const result = await checkFacilitatorFitness(manifest, { fetcher });
    const facet = result.detail?.["facilitator_fitness"] as {
      rails: Array<{ network: string }>;
    };
    expect(facet.rails.length).toBe(1);
    expect(facet.rails[0]!.network).toBe("");
  });

  it("tolerates malformed accepts[] entries (missing network)", async () => {
    const fetcher = (() => Promise.resolve(new Response("{}", { status: 200 }))) as typeof fetch;
    const manifest: WellKnownManifest = {
      accepts: [{ scheme: "exact" }, { network: "eip155:8453" }],
      extensions: { bazaar: { facilitator: "cdp" } },
    };
    const result = await checkFacilitatorFitness(manifest, { fetcher });
    const facet = result.detail?.["facilitator_fitness"] as {
      rails: Array<{ network: string }>;
    };
    expect(facet.rails.length).toBe(2);
    expect(facet.rails[0]!.network).toBe("");
    expect(facet.rails[1]!.network).toBe("eip155:8453");
  });

  it("handles non-object extensions.bazaar gracefully", async () => {
    const manifest: WellKnownManifest = {
      accepts: [{ network: "eip155:8453" }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      extensions: { bazaar: "not-an-object" as any },
    };
    const result = await checkFacilitatorFitness(manifest);
    expect(result.status).toBe("pass");
    const facet = result.detail?.["facilitator_fitness"] as {
      rails: Array<{ identity_source: string }>;
    };
    expect(facet.rails[0]!.identity_source).toBe("unknown");
  });

  it("trims whitespace from declared facilitator value", async () => {
    let probeUrl: string | undefined;
    const fetcher = ((url: string) => {
      probeUrl = url;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch;
    const manifest: WellKnownManifest = {
      accepts: [{ network: "eip155:8453" }],
      extensions: { bazaar: { facilitator: "  cdp  " } },
    };
    await checkFacilitatorFitness(manifest, { fetcher });
    expect(probeUrl).toContain("cdp.coinbase.com");
  });
});
