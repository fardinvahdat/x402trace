/**
 * X402-32 unit tests — well-known manifest check.
 */
import { describe, expect, it } from "vitest";
import { checkWellKnown, wellKnownUrlFor } from "../../src/bazaar/well-known.js";

const SERVICE = "https://api.example.test/some/route";
const WELL_KNOWN = "https://api.example.test/.well-known/x402";

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

describe("wellKnownUrlFor", () => {
  it("strips path from service URL and replaces with /.well-known/x402", () => {
    expect(wellKnownUrlFor(SERVICE)).toBe(WELL_KNOWN);
  });
  it("works on a bare origin (no path)", () => {
    expect(wellKnownUrlFor("https://x.test/")).toBe("https://x.test/.well-known/x402");
  });
});

describe("checkWellKnown", () => {
  it("passes on a well-formed manifest with name + description", async () => {
    const fetcher = mockFetch(() =>
      jsonResponse({ name: "My API", description: "Does things", accepts: [] }),
    );
    const { result } = await checkWellKnown(SERVICE, fetcher);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("My API");
  });

  it("fails when the well-known URL returns non-200", async () => {
    const fetcher = mockFetch(() => new Response("not found", { status: 404 }));
    const { result } = await checkWellKnown(SERVICE, fetcher);
    expect(result.status).toBe("fail");
    expect(result.message).toContain("404");
    expect(result.fix).toMatch(/manifest|\/\.well-known/i);
  });

  it("fails when the body is not valid JSON", async () => {
    const fetcher = mockFetch(
      () =>
        new Response("<html>oops</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    const { result } = await checkWellKnown(SERVICE, fetcher);
    expect(result.status).toBe("fail");
    expect(result.message).toMatch(/non-JSON/i);
  });

  it("fails when the body is a JSON array (not an object)", async () => {
    const fetcher = mockFetch(() => jsonResponse(["not", "an", "object"]));
    const { result } = await checkWellKnown(SERVICE, fetcher);
    expect(result.status).toBe("fail");
    expect(result.message).toMatch(/not a JSON object/i);
  });

  it("fails when name is missing", async () => {
    const fetcher = mockFetch(() => jsonResponse({ description: "ok" }));
    const { result } = await checkWellKnown(SERVICE, fetcher);
    expect(result.status).toBe("fail");
    expect(result.message).toMatch(/name/);
  });

  it("fails when description is missing OR empty", async () => {
    const fetcher = mockFetch(() => jsonResponse({ name: "X", description: "   " }));
    const { result } = await checkWellKnown(SERVICE, fetcher);
    expect(result.status).toBe("fail");
    expect(result.message).toMatch(/description/);
  });

  it("fails when accepts is present but not an array", async () => {
    const fetcher = mockFetch(() =>
      jsonResponse({ name: "X", description: "Y", accepts: { not: "an array" } }),
    );
    const { result } = await checkWellKnown(SERVICE, fetcher);
    expect(result.status).toBe("fail");
    expect(result.message).toMatch(/accepts/i);
  });

  it("fails gracefully on network error and reports the message", async () => {
    const fetcher = ((_url: string) =>
      Promise.reject(new Error("DNS lookup failed"))) as typeof fetch;
    const { result } = await checkWellKnown(SERVICE, fetcher);
    expect(result.status).toBe("fail");
    expect(result.message).toMatch(/DNS lookup failed/);
  });
});
