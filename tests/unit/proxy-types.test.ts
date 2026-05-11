import { describe, expect, it } from "vitest";
import { isLikelyX402Exchange } from "../../src/proxy/types.js";
import { newExchangeId } from "../../src/proxy/id.js";

describe("isLikelyX402Exchange", () => {
  const req = (headers: Record<string, string>) => ({
    method: "GET",
    path: "/api/weather",
    headers,
  });
  const res = (status: number, headers: Record<string, string> = {}) => ({ status, headers });

  it("returns true when request carries X-PAYMENT", () => {
    expect(isLikelyX402Exchange(req({ "x-payment": "..." }), res(200))).toBe(true);
  });

  it("returns true when request carries PAYMENT-SIGNATURE (v2)", () => {
    expect(isLikelyX402Exchange(req({ "payment-signature": "..." }), res(200))).toBe(true);
  });

  it("returns true when response is 402", () => {
    expect(isLikelyX402Exchange(req({}), res(402))).toBe(true);
  });

  it("returns true when response has X-PAYMENT-RESPONSE", () => {
    expect(isLikelyX402Exchange(req({}), res(200, { "x-payment-response": "..." }))).toBe(true);
  });

  it("returns false for plain non-x402 traffic", () => {
    expect(isLikelyX402Exchange(req({}), res(200))).toBe(false);
    expect(isLikelyX402Exchange(req({}), res(404))).toBe(false);
  });

  it("returns false when there is no response yet", () => {
    expect(isLikelyX402Exchange(req({}), undefined)).toBe(false);
  });
});

describe("newExchangeId", () => {
  it("returns a non-empty unique id each call", () => {
    const a = newExchangeId();
    const b = newExchangeId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });
});
