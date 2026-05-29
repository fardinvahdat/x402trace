/**
 * X402-53 (v0.3.4 L) — host-pollution check unit tests.
 *
 * Covers:
 *   - `parseResourceUrl` canonicalisation (host lowercasing, IDN, path
 *     extraction, malformed URL rejection)
 *   - `findHostPollution` grouping (single-host, multi-host, mixed)
 *   - `checkHostPollution` happy path + non-CDP short-circuit
 *   - `checkHostPollution` error paths: network fail, non-OK, non-JSON,
 *     empty resources, missing `resource` field on entries
 *   - Edge cases: 1 entry (no pollution possible), all same path,
 *     query-string-only differences (collapse to same canonical path),
 *     IDN hostname grouping
 */

import { describe, expect, it } from "vitest";
import {
  CDP_MERCHANT_DISCOVERY_BASE,
  checkHostPollution,
  findHostPollution,
  parseResourceUrl,
} from "../../src/bazaar/host-pollution.js";

const SAMPLE_PAYTO = "0x127462e296fAc1A7F5cF33bA57bB2f0FFf5cD0B6";

describe("parseResourceUrl", () => {
  it("extracts host + path from a normal URL", () => {
    expect(parseResourceUrl("https://api.anchor-x402.com/v1/anchor")).toEqual({
      host: "api.anchor-x402.com",
      path: "/v1/anchor",
    });
  });

  it("lowercases the host", () => {
    expect(parseResourceUrl("https://API.ANCHOR-X402.COM/v1/anchor")).toEqual({
      host: "api.anchor-x402.com",
      path: "/v1/anchor",
    });
  });

  it("drops query string + fragment from path", () => {
    expect(parseResourceUrl("https://api.anchor-x402.com/v1/anchor?q=1#frag")).toEqual({
      host: "api.anchor-x402.com",
      path: "/v1/anchor",
    });
  });

  it("handles deeply nested paths", () => {
    expect(parseResourceUrl("https://api.example.com/v1/decode/calldata")).toEqual({
      host: "api.example.com",
      path: "/v1/decode/calldata",
    });
  });

  it("returns null on malformed URLs", () => {
    expect(parseResourceUrl("not-a-url")).toBeNull();
    expect(parseResourceUrl("")).toBeNull();
  });

  it("normalises an IDN hostname to ACE form via WHATWG URL", () => {
    // Punycode → host stored in IDN ACE form (xn--) consistently
    const parsed = parseResourceUrl("https://例え.example/v1/anchor");
    expect(parsed).not.toBeNull();
    expect(parsed!.host.startsWith("xn--") || parsed!.host === "例え.example").toBe(true);
    expect(parsed!.path).toBe("/v1/anchor");
  });
});

describe("findHostPollution", () => {
  it("returns empty pollution for a single-host fleet", () => {
    const result = findHostPollution([
      "https://api.example.com/v1/a",
      "https://api.example.com/v1/b",
      "https://api.example.com/v1/c",
    ]);
    expect(result.pollutedPaths).toEqual([]);
    expect(result.totalEntries).toBe(3);
    expect(result.distinctHosts).toBe(1);
  });

  it("detects a path indexed on two hosts", () => {
    const result = findHostPollution([
      "https://api.example.com/v1/anchor",
      "https://1c09.execute-api.us-east-1.amazonaws.com/v1/anchor",
    ]);
    expect(result.pollutedPaths).toEqual([
      {
        resource_path: "/v1/anchor",
        hosts: ["1c09.execute-api.us-east-1.amazonaws.com", "api.example.com"],
      },
    ]);
    expect(result.totalEntries).toBe(2);
    expect(result.distinctHosts).toBe(2);
  });

  it("sorts polluted paths by resource_path ascending", () => {
    const result = findHostPollution([
      "https://h1/v1/z",
      "https://h2/v1/z",
      "https://h1/v1/a",
      "https://h2/v1/a",
      "https://h1/v1/m",
      "https://h2/v1/m",
    ]);
    expect(result.pollutedPaths.map((p) => p.resource_path)).toEqual(["/v1/a", "/v1/m", "/v1/z"]);
  });

  it("sorts hosts within each polluted entry ascending", () => {
    const result = findHostPollution(["https://zzz/v1/a", "https://aaa/v1/a", "https://mmm/v1/a"]);
    expect(result.pollutedPaths[0]!.hosts).toEqual(["aaa", "mmm", "zzz"]);
  });

  it("treats query-string-only differences as the same canonical path", () => {
    const result = findHostPollution([
      "https://api.example.com/v1/anchor?q=1",
      "https://api.example.com/v1/anchor?q=2",
    ]);
    expect(result.pollutedPaths).toEqual([]); // same host, same path
    expect(result.totalEntries).toBe(2);
    expect(result.distinctHosts).toBe(1);
  });

  it("flags pollution from query-string-only differences on different hosts", () => {
    const result = findHostPollution([
      "https://api.example.com/v1/anchor?q=1",
      "https://gateway.example.com/v1/anchor?q=2",
    ]);
    expect(result.pollutedPaths).toEqual([
      {
        resource_path: "/v1/anchor",
        hosts: ["api.example.com", "gateway.example.com"],
      },
    ]);
  });

  it("ignores malformed URLs but counts valid ones", () => {
    const result = findHostPollution([
      "https://api.example.com/v1/anchor",
      "not-a-url",
      "https://gateway.example.com/v1/anchor",
      "",
    ]);
    expect(result.totalEntries).toBe(2);
    expect(result.pollutedPaths).toHaveLength(1);
  });

  it("handles the Ferj anchor-x402 shape (3 hosts × 9 polluted paths)", () => {
    // Simulates the actual fixture shape — 9 paths each appearing on
    // api.anchor-x402.com AND the raw API Gateway URL.
    const urls: string[] = [];
    const polluted = [
      "/v1/anchor",
      "/v1/attest",
      "/v1/decode/calldata",
      "/v1/decode/tx",
      "/v1/intel/wallet",
      "/v1/parse/datetime",
      "/v1/price/token",
      "/v1/resolve/name",
      "/v1/screen",
    ];
    for (const p of polluted) {
      urls.push(`https://api.anchor-x402.com${p}`);
      urls.push(`https://1c09pdnrx1.execute-api.us-east-1.amazonaws.com${p}`);
    }
    const result = findHostPollution(urls);
    expect(result.pollutedPaths).toHaveLength(9);
    expect(result.distinctHosts).toBe(2);
    expect(result.totalEntries).toBe(18);
    for (const p of result.pollutedPaths) {
      expect(p.hosts).toEqual([
        "1c09pdnrx1.execute-api.us-east-1.amazonaws.com",
        "api.anchor-x402.com",
      ]);
    }
  });
});

describe("checkHostPollution — non-CDP short-circuit", () => {
  it("returns not_applicable_non_cdp when manifest declares non-CDP facilitator", async () => {
    const result = await checkHostPollution(SAMPLE_PAYTO, {
      manifest: {
        extensions: {
          bazaar: { facilitator: "https://facilitator.payai.network" },
        },
      },
    });
    expect(result.status).toBe("pass");
    expect(result.detail?.["state"]).toBe("not_applicable_non_cdp");
  });
});

describe("checkHostPollution — happy path", () => {
  it("returns pass + no_pollution when single-host index", async () => {
    const fetcher: typeof fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            pagination: { limit: 50, offset: 0, total: 2 },
            payTo: SAMPLE_PAYTO,
            resources: [
              { resource: "https://api.example.com/v1/a" },
              { resource: "https://api.example.com/v1/b" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )) as typeof fetch;

    const result = await checkHostPollution(SAMPLE_PAYTO, { fetcher });
    expect(result.status).toBe("pass");
    expect(result.detail?.["state"]).toBe("no_pollution");
    expect(result.detail?.["total_entries"]).toBe(2);
    expect(result.detail?.["distinct_hosts"]).toBe(1);
  });

  it("returns info + polluted when multi-host", async () => {
    const fetcher: typeof fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            pagination: { limit: 50, offset: 0, total: 4 },
            payTo: SAMPLE_PAYTO,
            resources: [
              { resource: "https://api.example.com/v1/anchor" },
              { resource: "https://gateway.example.com/v1/anchor" },
              { resource: "https://api.example.com/v1/attest" },
              { resource: "https://gateway.example.com/v1/attest" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )) as typeof fetch;

    const result = await checkHostPollution(SAMPLE_PAYTO, { fetcher });
    expect(result.status).toBe("info");
    expect(result.detail?.["state"]).toBe("polluted");
    expect(result.detail?.["polluted_path_count"]).toBe(2);
    expect(result.detail?.["distinct_hosts"]).toBe(2);
    expect(result.fix).toContain("listing-hygiene");
  });
});

describe("checkHostPollution — error paths", () => {
  it("returns pass + unknown on network failure", async () => {
    const fetcher: typeof fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
    const result = await checkHostPollution(SAMPLE_PAYTO, { fetcher });
    expect(result.status).toBe("pass");
    expect(result.detail?.["state"]).toBe("unknown");
    expect(result.message).toContain("ECONNREFUSED");
  });

  it("returns pass + unknown on non-2xx response", async () => {
    const fetcher: typeof fetch = (() =>
      Promise.resolve(new Response("internal error", { status: 500 }))) as typeof fetch;
    const result = await checkHostPollution(SAMPLE_PAYTO, { fetcher });
    expect(result.status).toBe("pass");
    expect(result.detail?.["state"]).toBe("unknown");
    expect(result.detail?.["httpStatus"]).toBe(500);
  });

  it("returns pass + unknown on non-JSON body", async () => {
    const fetcher: typeof fetch = (() =>
      Promise.resolve(
        new Response("<html>oops</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      )) as typeof fetch;
    const result = await checkHostPollution(SAMPLE_PAYTO, { fetcher });
    expect(result.status).toBe("pass");
    expect(result.detail?.["state"]).toBe("unknown");
  });

  it("returns pass + no_pollution when resources array is empty", async () => {
    const fetcher: typeof fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ resources: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )) as typeof fetch;
    const result = await checkHostPollution(SAMPLE_PAYTO, { fetcher });
    expect(result.status).toBe("pass");
    expect(result.detail?.["state"]).toBe("no_pollution");
    expect(result.detail?.["total_entries"]).toBe(0);
  });

  it("returns pass + no_pollution when entries lack the resource field", async () => {
    const fetcher: typeof fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            resources: [{ irrelevant: true }, { also: "irrelevant" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )) as typeof fetch;
    const result = await checkHostPollution(SAMPLE_PAYTO, { fetcher });
    expect(result.status).toBe("pass");
    expect(result.detail?.["state"]).toBe("no_pollution");
  });
});

describe("checkHostPollution — URL construction", () => {
  it("queries the default CDP merchant base by default", async () => {
    let capturedUrl: string | undefined;
    const fetcher: typeof fetch = ((url: string) => {
      capturedUrl = url;
      return Promise.resolve(
        new Response(JSON.stringify({ resources: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;

    await checkHostPollution(SAMPLE_PAYTO, { fetcher });
    expect(capturedUrl).toBe(
      `${CDP_MERCHANT_DISCOVERY_BASE}/platform/v2/x402/discovery/merchant?payTo=${encodeURIComponent(SAMPLE_PAYTO)}&limit=50`,
    );
  });

  it("honours discoveryBaseUrl override + custom limit", async () => {
    let capturedUrl: string | undefined;
    const fetcher: typeof fetch = ((url: string) => {
      capturedUrl = url;
      return Promise.resolve(
        new Response(JSON.stringify({ resources: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;

    await checkHostPollution(SAMPLE_PAYTO, {
      fetcher,
      discoveryBaseUrl: "https://test-cdp.example.com/",
      limit: 25,
    });
    expect(capturedUrl).toBe(
      `https://test-cdp.example.com/platform/v2/x402/discovery/merchant?payTo=${encodeURIComponent(SAMPLE_PAYTO)}&limit=25`,
    );
  });
});
