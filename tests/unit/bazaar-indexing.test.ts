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
});
