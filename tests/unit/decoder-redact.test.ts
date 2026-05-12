import { describe, expect, it } from "vitest";
import { redactPaymentPayload } from "../../src/decoder/redact.js";
import type { PaymentPayload } from "../../src/decoder/types.js";

const SAMPLE: PaymentPayload = {
  x402Version: 1,
  scheme: "exact",
  network: "base-sepolia",
  payload: {
    signature: "0xdeadbeef" + "0".repeat(124),
    authorization: {
      from: "0xfrom",
      to: "0xto",
      value: "1000",
      validAfter: "0",
      validBefore: "1750000000",
      nonce: "0x" + "f".repeat(64),
    },
  },
};

describe("redactPaymentPayload", () => {
  it("replaces signature with [REDACTED] when logSecrets=false", () => {
    const out = redactPaymentPayload(SAMPLE, false);
    expect(out.payload.signature).toBe("[REDACTED]");
    expect(out.payload.authorization.nonce).toBe(SAMPLE.payload.authorization.nonce);
  });

  it("returns the original when logSecrets=true", () => {
    const out = redactPaymentPayload(SAMPLE, true);
    expect(out).toBe(SAMPLE);
  });

  it("does not mutate the input when redacting", () => {
    const original = JSON.parse(JSON.stringify(SAMPLE)) as PaymentPayload;
    redactPaymentPayload(SAMPLE, false);
    expect(SAMPLE).toEqual(original);
  });
});
