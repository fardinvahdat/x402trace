/**
 * X402-35 unit tests — facilitator alias parsing + /verify call shape
 * + diff aggregate verdict synthesis.
 */
import { describe, expect, it } from "vitest";
import {
  callFacilitatorVerify,
  knownFacilitatorAliases,
  parseFacilitatorList,
  runFacilitatorDiff,
  type DiffFetcher,
  type FacilitatorEntry,
} from "../../src/cli/validate-facilitator-diff.js";
import type { DiagnosticContext } from "../../src/diagnose/types.js";

const PAYER = "0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895";
const PAYEE = "0x1111111111111111111111111111111111111111";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function baseCtx(): Omit<DiagnosticContext, "facilitator"> {
  return {
    requirements: {
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "1000",
      resource: "http://example.test/api/weather",
      payTo: PAYEE,
      asset: USDC,
      maxTimeoutSeconds: 300,
    },
    payment: {
      x402Version: 1,
      scheme: "exact",
      network: "base-sepolia",
      payload: {
        signature: "[SIMULATED]",
        authorization: {
          from: PAYER,
          to: PAYEE,
          value: "1000",
          validAfter: "0",
          validBefore: String(Math.floor(Date.now() / 1000) + 300),
          nonce: `0x${"0".repeat(64)}`,
        },
      },
    },
    now: new Date(),
  };
}

describe("parseFacilitatorList", () => {
  it("rejects a single-entry list (--diff requires ≥2)", () => {
    const r = parseFacilitatorList("cdp");
    expect(r.ok).toBe(false);
  });

  it("rejects empty input", () => {
    const r = parseFacilitatorList("");
    expect(r.ok).toBe(false);
  });

  it("resolves known aliases (cdp, xpay)", () => {
    const r = parseFacilitatorList("cdp,xpay");
    if (!r.ok) throw new Error(r.message);
    expect(r.facilitators.map((f) => f.id)).toEqual(["cdp", "xpay"]);
    expect(r.facilitators[0]!.verifyUrl).toMatch(/cdp\.coinbase\.com/);
    expect(r.facilitators[1]!.verifyUrl).toMatch(/xpay/);
  });

  it("is case-insensitive about alias names", () => {
    const r = parseFacilitatorList("CDP,X402.ORG");
    if (!r.ok) throw new Error(r.message);
    expect(r.facilitators.map((f) => f.id)).toEqual(["cdp", "x402.org"]);
  });

  it("accepts full URLs alongside aliases", () => {
    const r = parseFacilitatorList("cdp,https://my-fac.example/facilitator");
    if (!r.ok) throw new Error(r.message);
    expect(r.facilitators[1]!.verifyUrl).toBe("https://my-fac.example/facilitator/verify");
  });

  it("rejects unknown aliases that aren't valid URLs", () => {
    const r = parseFacilitatorList("cdp,sketchy-fac");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/sketchy-fac/);
  });

  it("knownFacilitatorAliases() returns the documented list", () => {
    const aliases = knownFacilitatorAliases();
    expect(aliases).toContain("cdp");
    expect(aliases).toContain("xpay");
    expect(aliases).toContain("payai");
    expect(aliases).toContain("x402.org");
  });
});

describe("callFacilitatorVerify", () => {
  const FAC: FacilitatorEntry = {
    id: "test",
    baseUrl: "https://example.test/facilitator",
    verifyUrl: "https://example.test/facilitator/verify",
  };

  function jsonResponse(
    body: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  }

  it("captures 200 + isValid:true as accepted in the interaction", async () => {
    const fetcher: DiffFetcher = async () => jsonResponse({ isValid: true, payer: PAYER });
    const r = await callFacilitatorVerify(
      FAC,
      { paymentPayload: {}, paymentRequirements: {} },
      { fetcher },
    );
    expect(r.statusCode).toBe(200);
    expect(r.response?.isValid).toBe(true);
  });

  it("captures 200 + isValid:false + invalidReason", async () => {
    const fetcher: DiffFetcher = async () =>
      jsonResponse({ isValid: false, invalidReason: "signature_mismatch" });
    const r = await callFacilitatorVerify(
      FAC,
      { paymentPayload: {}, paymentRequirements: {} },
      { fetcher },
    );
    expect(r.statusCode).toBe(200);
    expect(r.response?.isValid).toBe(false);
    expect(r.response?.invalidReason).toBe("signature_mismatch");
  });

  it("captures 4xx with body as errorMessage when body is not JSON", async () => {
    const fetcher: DiffFetcher = async () => new Response("invalid_payload", { status: 400 });
    const r = await callFacilitatorVerify(
      FAC,
      { paymentPayload: {}, paymentRequirements: {} },
      { fetcher },
    );
    expect(r.statusCode).toBe(400);
    expect(r.errorMessage).toBe("invalid_payload");
  });

  it("captures network failure as statusCode 0 + errorMessage", async () => {
    const fetcher: DiffFetcher = async () => {
      throw new Error("ENOTFOUND");
    };
    const r = await callFacilitatorVerify(
      FAC,
      { paymentPayload: {}, paymentRequirements: {} },
      { fetcher },
    );
    expect(r.statusCode).toBe(0);
    expect(r.errorMessage).toMatch(/ENOTFOUND/);
  });

  it("captures timeout when the fetcher aborts via the AbortSignal", async () => {
    const fetcher: DiffFetcher = async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    };
    const r = await callFacilitatorVerify(
      FAC,
      { paymentPayload: {}, paymentRequirements: {} },
      { fetcher, timeoutMs: 5 },
    );
    expect(r.statusCode).toBe(0);
    expect(r.errorMessage).toMatch(/timeout/);
  });

  it("normalizes headers to lowercase keys", async () => {
    const fetcher: DiffFetcher = async () =>
      jsonResponse({ isValid: true }, 200, { "EXTENSION-Responses": "bazaar=ok" });
    const r = await callFacilitatorVerify(
      FAC,
      { paymentPayload: {}, paymentRequirements: {} },
      { fetcher },
    );
    expect(r.headers?.["extension-responses"]).toBe("bazaar=ok");
  });
});

describe("runFacilitatorDiff", () => {
  const CDP: FacilitatorEntry = {
    id: "cdp",
    baseUrl: "https://api.cdp.coinbase.com",
    verifyUrl: "https://api.cdp.coinbase.com/platform/v2/x402/verify",
  };
  const XPAY: FacilitatorEntry = {
    id: "xpay",
    baseUrl: "https://xpay.org/facilitator",
    verifyUrl: "https://xpay.org/facilitator/verify",
  };

  it("returns kind: 'any_accepts' with exitCode 0 when at least one facilitator accepts", async () => {
    const fetcher: DiffFetcher = async (url) => {
      if (url.includes("xpay")) {
        return new Response(JSON.stringify({ isValid: true, payer: PAYER }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ isValid: false, invalidReason: "x" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const agg = await runFacilitatorDiff(
      [CDP, XPAY],
      { paymentPayload: {}, paymentRequirements: {} },
      baseCtx(),
      { fetcher },
    );
    expect(agg.verdict.kind).toBe("any_accepts");
    expect(agg.verdict.exitCode).toBe(0);
    if (agg.verdict.kind === "any_accepts") expect(agg.verdict.accepted).toEqual(["xpay"]);
  });

  it("returns kind: 'all_reject' with exitCode 2 when no facilitator accepts", async () => {
    const fetcher: DiffFetcher = async () =>
      new Response(JSON.stringify({ isValid: false, invalidReason: "signature_mismatch" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const agg = await runFacilitatorDiff(
      [CDP, XPAY],
      { paymentPayload: {}, paymentRequirements: {} },
      baseCtx(),
      { fetcher },
    );
    expect(agg.verdict.kind).toBe("all_reject");
    expect(agg.verdict.exitCode).toBe(2);
  });

  it("returns kind: 'all_timeout' with exitCode 3 when every facilitator times out", async () => {
    const fetcher: DiffFetcher = async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    };
    const agg = await runFacilitatorDiff(
      [CDP, XPAY],
      { paymentPayload: {}, paymentRequirements: {} },
      baseCtx(),
      { fetcher, timeoutMs: 5 },
    );
    expect(agg.verdict.kind).toBe("all_timeout");
    expect(agg.verdict.exitCode).toBe(3);
  });

  it("runs facilitator calls in parallel (Promise.all timing)", async () => {
    const start = Date.now();
    const fetcher: DiffFetcher = async () => {
      await new Promise((r) => setTimeout(r, 50));
      return new Response(JSON.stringify({ isValid: false, invalidReason: "x" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    await runFacilitatorDiff(
      [CDP, XPAY],
      { paymentPayload: {}, paymentRequirements: {} },
      baseCtx(),
      { fetcher },
    );
    const elapsed = Date.now() - start;
    // Parallel: ~50ms total. Sequential would be ~100ms. Comfortable margin
    // for CI scheduling jitter.
    expect(elapsed).toBeLessThan(150);
  });

  it("feeds the captured FacilitatorInteraction into diagnose so X402-33 rules fire per-facilitator", async () => {
    // CDP throttling: 403 forbidden. facilitatorThrottlingRule should fail
    // on this facilitator's diagnostic report.
    const fetcher: DiffFetcher = async () => new Response("Forbidden", { status: 403 });
    const agg = await runFacilitatorDiff(
      [CDP],
      { paymentPayload: {}, paymentRequirements: {} },
      baseCtx(),
      { fetcher },
    );
    const cdpResult = agg.results[0]!;
    const throttling = cdpResult.diagnostics.results.find(
      (r) => r.rule === "facilitator-throttling",
    );
    expect(throttling?.status).toBe("fail");
  });
});
