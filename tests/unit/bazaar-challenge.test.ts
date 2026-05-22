/**
 * X402-32 unit tests — 402 challenge structure + self-payment guard.
 */
import { describe, expect, it } from "vitest";
import { checkChallenge, checkSelfPayment, fetchChallenge } from "../../src/bazaar/challenge.js";

const SERVICE = "https://api.example.test/api/weather";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function challengeBody(extras: Record<string, unknown> = {}): unknown {
  return {
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
    ...extras,
  };
}

function mockFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return ((url: string) => Promise.resolve(handler(url))) as typeof fetch;
}

describe("fetchChallenge", () => {
  it("returns ok when service responds with a well-formed 402", async () => {
    const fetcher = mockFetch(
      () =>
        new Response(JSON.stringify(challengeBody()), {
          status: 402,
          headers: { "content-type": "application/json" },
        }),
    );
    const r = await fetchChallenge(SERVICE, fetcher);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.requirements.payTo).toBe(PAY_TO);
    }
  });

  it("returns not-ok with httpStatus when service returns non-402 (200)", async () => {
    const fetcher = mockFetch(() => new Response("ok", { status: 200 }));
    const r = await fetchChallenge(SERVICE, fetcher);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.httpStatus).toBe(200);
      expect(r.reason).toMatch(/402/);
    }
  });

  it("returns not-ok when the 402 body is not valid JSON", async () => {
    const fetcher = mockFetch(() => new Response("<html>weird</html>", { status: 402 }));
    const r = await fetchChallenge(SERVICE, fetcher);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/parse failed/i);
    }
  });
});

describe("checkChallenge", () => {
  it("fails when the upstream fetch was not ok", () => {
    const r = checkChallenge(SERVICE, { ok: false, reason: "bang", httpStatus: 500 });
    expect(r.status).toBe("fail");
    expect(r.fix).toMatch(/middleware|x402/i);
  });

  it("passes (no bazaar requirement) when expectBazaar is false", () => {
    const r = checkChallenge(
      SERVICE,
      {
        ok: true,
        requirements: {
          scheme: "exact",
          network: "base-sepolia",
          maxAmountRequired: "1000",
          resource: SERVICE,
          payTo: PAY_TO,
          asset: USDC,
          maxTimeoutSeconds: 300,
        },
        rawBody: { foo: "bar" },
      },
      { expectBazaar: false },
    );
    expect(r.status).toBe("pass");
  });

  it("fails when extensions object is absent (default expectBazaar)", () => {
    const r = checkChallenge(SERVICE, {
      ok: true,
      requirements: {
        scheme: "exact",
        network: "base-sepolia",
        maxAmountRequired: "1000",
        resource: SERVICE,
        payTo: PAY_TO,
        asset: USDC,
        maxTimeoutSeconds: 300,
      },
      rawBody: challengeBody(),
    });
    expect(r.status).toBe("fail");
    expect(r.message).toMatch(/extensions|bazaar/i);
  });

  it("fails when extensions exists but extensions.bazaar is absent", () => {
    const r = checkChallenge(SERVICE, {
      ok: true,
      requirements: {
        scheme: "exact",
        network: "base-sepolia",
        maxAmountRequired: "1000",
        resource: SERVICE,
        payTo: PAY_TO,
        asset: USDC,
        maxTimeoutSeconds: 300,
      },
      rawBody: challengeBody({ extensions: { something_else: true } }),
    });
    expect(r.status).toBe("fail");
    expect(r.message).toMatch(/bazaar/i);
  });

  it("fails when extensions.bazaar.name is missing", () => {
    const r = checkChallenge(SERVICE, {
      ok: true,
      requirements: {
        scheme: "exact",
        network: "base-sepolia",
        maxAmountRequired: "1000",
        resource: SERVICE,
        payTo: PAY_TO,
        asset: USDC,
        maxTimeoutSeconds: 300,
      },
      rawBody: challengeBody({ extensions: { bazaar: { description: "ok" } } }),
    });
    expect(r.status).toBe("fail");
    expect(r.message).toMatch(/name/);
  });

  it("fails when extensions.bazaar.description is empty string", () => {
    const r = checkChallenge(SERVICE, {
      ok: true,
      requirements: {
        scheme: "exact",
        network: "base-sepolia",
        maxAmountRequired: "1000",
        resource: SERVICE,
        payTo: PAY_TO,
        asset: USDC,
        maxTimeoutSeconds: 300,
      },
      rawBody: challengeBody({ extensions: { bazaar: { name: "ok", description: "   " } } }),
    });
    expect(r.status).toBe("fail");
    expect(r.message).toMatch(/description/);
  });

  it("passes when extensions.bazaar has both name and description", () => {
    const r = checkChallenge(SERVICE, {
      ok: true,
      requirements: {
        scheme: "exact",
        network: "base-sepolia",
        maxAmountRequired: "1000",
        resource: SERVICE,
        payTo: PAY_TO,
        asset: USDC,
        maxTimeoutSeconds: 300,
      },
      rawBody: challengeBody({
        extensions: { bazaar: { name: "Catalog API", description: "Esim providers" } },
      }),
    });
    expect(r.status).toBe("pass");
    expect(r.message).toMatch(/Catalog API/);
  });
});

// ---- X402-43 (D.5) variant-aware extensions.bazaar ----
//
// AsaiShota #72 + 0xdespot #2207 — body-discovery shape (info.input +
// info.output + schema) was false-positive `implementation_issue` in
// v0.3.0/0.3.1. These tests cover the variant-aware refactor.

describe("checkChallenge — body-discovery variant (D.5)", () => {
  function bodyDiscoveryChallenge(bazaarOverride: Record<string, unknown> = {}): unknown {
    return challengeBody({
      extensions: {
        bazaar: {
          info: {
            input: { type: "object", properties: { q: { type: "string" } } },
            output: { type: "object", properties: { result: { type: "string" } } },
          },
          schema: { version: 1 },
          ...bazaarOverride,
        },
      },
    });
  }

  it("passes on a well-formed body-discovery extensions.bazaar shape (AsaiShota #72 + 0xdespot regression guard)", () => {
    const r = checkChallenge(SERVICE, {
      ok: true,
      requirements: {
        scheme: "exact",
        network: "base-sepolia",
        maxAmountRequired: "1000",
        resource: SERVICE,
        payTo: PAY_TO,
        asset: USDC,
        maxTimeoutSeconds: 300,
      },
      rawBody: bodyDiscoveryChallenge(),
    });
    expect(r.status).toBe("pass");
    expect(r.message).toMatch(/body-discovery/);
  });

  it("fails when body-discovery is missing info.output", () => {
    const r = checkChallenge(SERVICE, {
      ok: true,
      requirements: {
        scheme: "exact",
        network: "base-sepolia",
        maxAmountRequired: "1000",
        resource: SERVICE,
        payTo: PAY_TO,
        asset: USDC,
        maxTimeoutSeconds: 300,
      },
      rawBody: bodyDiscoveryChallenge({ info: { input: {}, output: null } }),
    });
    expect(r.status).toBe("fail");
    expect(r.message).toMatch(/info\.output/);
    expect(r.detail?.variant).toBe("body-discovery");
  });

  it("fails when body-discovery is missing schema", () => {
    const r = checkChallenge(SERVICE, {
      ok: true,
      requirements: {
        scheme: "exact",
        network: "base-sepolia",
        maxAmountRequired: "1000",
        resource: SERVICE,
        payTo: PAY_TO,
        asset: USDC,
        maxTimeoutSeconds: 300,
      },
      rawBody: bodyDiscoveryChallenge({ schema: "not an object" }),
    });
    expect(r.status).toBe("fail");
    expect(r.message).toMatch(/schema/);
    expect(r.detail?.variant).toBe("body-discovery");
  });

  it("passes when body-discovery indicators are present even without top-level name/description (body wins over mcp default)", () => {
    // The hybrid case: an object that has both shapes' fields. Body
    // indicators take precedence per ADR-004 design — services that
    // ship info.input/output/schema are body-discovery by design.
    const r = checkChallenge(SERVICE, {
      ok: true,
      requirements: {
        scheme: "exact",
        network: "base-sepolia",
        maxAmountRequired: "1000",
        resource: SERVICE,
        payTo: PAY_TO,
        asset: USDC,
        maxTimeoutSeconds: 300,
      },
      rawBody: bodyDiscoveryChallenge(), // No name/description, just info+schema
    });
    expect(r.status).toBe("pass");
    expect(r.message).toMatch(/body-discovery/);
  });
});

describe("checkSelfPayment", () => {
  it("passes when no payerHint is supplied (silent default)", () => {
    const r = checkSelfPayment(PAY_TO);
    expect(r.status).toBe("pass");
  });

  it("passes when payerHint differs from payTo", () => {
    const r = checkSelfPayment(PAY_TO, "0x2222222222222222222222222222222222222222");
    expect(r.status).toBe("pass");
  });

  it("fails when payerHint equals payTo (case-insensitive)", () => {
    const r = checkSelfPayment(PAY_TO.toLowerCase(), PAY_TO.toUpperCase());
    expect(r.status).toBe("fail");
    expect(r.fix).toMatch(/xpay|different wallet/i);
  });
});
