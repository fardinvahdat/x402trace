/**
 * X402-32 unit tests — indexing query.
 */
import { describe, expect, it } from "vitest";
import { CDP_DISCOVERY_BASE, checkIndexing } from "../../src/bazaar/indexing.js";

const PAY_TO = "0x1111111111111111111111111111111111111111";

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

describe("checkIndexing", () => {
  it("queries the canonical CDP discovery URL by default", async () => {
    let observed = "";
    const fetcher = mockFetch((url) => {
      observed = url;
      return jsonResponse({ resources: [{ id: "r1" }] });
    });
    await checkIndexing(PAY_TO, { fetcher });
    expect(observed).toMatch(new RegExp(`^${CDP_DISCOVERY_BASE.replace(/\//g, "\\/")}`));
    expect(observed).toContain(`payTo=${encodeURIComponent(PAY_TO)}`);
  });

  it("passes when discovery returns non-empty resources", async () => {
    const fetcher = mockFetch(() => jsonResponse({ resources: [{ id: "r1" }, { id: "r2" }] }));
    const r = await checkIndexing(PAY_TO, { fetcher });
    expect(r.status).toBe("pass");
    expect(r.message).toMatch(/2 resource\(s\)/);
  });

  it("returns info (not fail) when discovery returns empty resources — upstream issue", async () => {
    const fetcher = mockFetch(() => jsonResponse({ resources: [] }));
    const r = await checkIndexing(PAY_TO, { fetcher });
    expect(r.status).toBe("info");
    expect(r.message).toMatch(/0 resources/);
    expect(r.fix).toMatch(/#2207/);
  });

  it("returns info on 404 — also upstream / not-yet-indexed", async () => {
    const fetcher = mockFetch(() => new Response("", { status: 404 }));
    const r = await checkIndexing(PAY_TO, { fetcher });
    expect(r.status).toBe("info");
    expect(r.message).toMatch(/404|not indexed/i);
  });

  it("returns info on non-OK 5xx — upstream error", async () => {
    const fetcher = mockFetch(() => new Response("server down", { status: 503 }));
    const r = await checkIndexing(PAY_TO, { fetcher });
    expect(r.status).toBe("info");
    expect(r.message).toMatch(/503/);
  });

  it("returns info when discovery returns non-JSON body", async () => {
    const fetcher = mockFetch(
      () => new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const r = await checkIndexing(PAY_TO, { fetcher });
    expect(r.status).toBe("info");
    expect(r.message).toMatch(/non-JSON/i);
  });

  it("returns info on network error (caller-side / DNS)", async () => {
    const fetcher = ((_url: string) => Promise.reject(new Error("ENOTFOUND"))) as typeof fetch;
    const r = await checkIndexing(PAY_TO, { fetcher });
    expect(r.status).toBe("info");
    expect(r.message).toMatch(/ENOTFOUND/);
  });

  it("honours the discoveryBaseUrl override (for alternate facilitators)", async () => {
    let observed = "";
    const fetcher = mockFetch((url) => {
      observed = url;
      return jsonResponse({ resources: [] });
    });
    await checkIndexing(PAY_TO, {
      fetcher,
      discoveryBaseUrl: "https://my-test-facilitator.example",
    });
    expect(observed.startsWith("https://my-test-facilitator.example")).toBe(true);
  });

  // ---- X402-46 (D.3) indexer_state facet ----

  describe("indexer_state facet", () => {
    it("emits indexer_state=indexed on the pass path", async () => {
      const fetcher = mockFetch(() => jsonResponse({ resources: [{ id: "r1" }] }));
      const r = await checkIndexing(PAY_TO, { fetcher });
      expect(r.detail?.indexer_state).toBe("indexed");
    });

    it("emits indexer_state=processing on empty resources (the #2207 stuck pattern)", async () => {
      const fetcher = mockFetch(() => jsonResponse({ resources: [] }));
      const r = await checkIndexing(PAY_TO, { fetcher });
      expect(r.detail?.indexer_state).toBe("processing");
    });

    it("emits indexer_state=processing on 404 (also #2207 stuck pattern)", async () => {
      const fetcher = mockFetch(() => new Response("", { status: 404 }));
      const r = await checkIndexing(PAY_TO, { fetcher });
      expect(r.detail?.indexer_state).toBe("processing");
    });

    it("emits indexer_state=unknown on 5xx / non-JSON / network error", async () => {
      const fetcher5xx = mockFetch(() => new Response("err", { status: 503 }));
      const r5xx = await checkIndexing(PAY_TO, { fetcher: fetcher5xx });
      expect(r5xx.detail?.indexer_state).toBe("unknown");

      const fetcherNetErr = ((_url: string) =>
        Promise.reject(new Error("ENOTFOUND"))) as typeof fetch;
      const rNetErr = await checkIndexing(PAY_TO, { fetcher: fetcherNetErr });
      expect(rNetErr.detail?.indexer_state).toBe("unknown");
    });
  });

  // ---- X402-46 (D.3) not_applicable_non_cdp short-circuit ----

  describe("not_applicable_non_cdp (manifest-claim)", () => {
    it("returns pass + indexer_state=not_applicable_non_cdp when manifest declares non-CDP facilitator", async () => {
      // Fetcher should NOT be called — short-circuit fires before the network probe.
      let fetcherCalled = false;
      const fetcher = mockFetch(() => {
        fetcherCalled = true;
        return jsonResponse({ resources: [] });
      });
      const r = await checkIndexing(PAY_TO, {
        fetcher,
        manifest: {
          name: "X",
          description: "Y",
          extensions: { bazaar: { facilitator: "x402-rs" } },
        },
      });
      expect(r.status).toBe("pass");
      expect(r.detail?.indexer_state).toBe("not_applicable_non_cdp");
      expect(r.message).toMatch(/non-CDP|ADR-004 Pillar 3/);
      expect(fetcherCalled).toBe(false);
    });

    it("does NOT short-circuit when manifest declares CDP — proceeds with normal query", async () => {
      let fetcherCalled = false;
      const fetcher = mockFetch(() => {
        fetcherCalled = true;
        return jsonResponse({ resources: [{ id: "r1" }] });
      });
      const r = await checkIndexing(PAY_TO, {
        fetcher,
        manifest: {
          name: "X",
          description: "Y",
          extensions: { bazaar: { facilitator: "coinbase-cdp" } },
        },
      });
      expect(r.status).toBe("pass");
      expect(r.detail?.indexer_state).toBe("indexed");
      expect(fetcherCalled).toBe(true);
    });

    it("does NOT short-circuit when manifest is undefined — proceeds with normal query (preserves --endpoint mode)", async () => {
      let fetcherCalled = false;
      const fetcher = mockFetch(() => {
        fetcherCalled = true;
        return jsonResponse({ resources: [] });
      });
      const r = await checkIndexing(PAY_TO, { fetcher });
      expect(r.detail?.indexer_state).toBe("processing");
      expect(fetcherCalled).toBe(true);
    });
  });
});
