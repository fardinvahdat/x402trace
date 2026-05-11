import { describe, expect, it } from "vitest";
import {
  detectVersion,
  findPaymentHeader,
  findSettlementHeader,
  parseChallengeBody,
  parsePaymentHeader,
  parseSettlementHeader,
} from "../../src/decoder/parse.js";

const V1_CHALLENGE_BODY = JSON.stringify({
  error: "X-PAYMENT header is required",
  accepts: [
    {
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "1000",
      resource: "http://localhost:3402/api/weather",
      description: "test",
      mimeType: "application/json",
      payTo: "0x1111111111111111111111111111111111111111",
      maxTimeoutSeconds: 300,
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      outputSchema: { input: { type: "http", method: "GET", discoverable: true } },
      extra: { name: "USDC", version: "2" },
    },
  ],
  x402Version: 1,
});

const V2_CHALLENGE_BODY = JSON.stringify({
  error: "PAYMENT-SIGNATURE header is required",
  accepts: [
    {
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "1000",
      resource: "http://localhost:3402/api/weather",
      description: "test",
      mimeType: "application/json",
      payTo: "0x1111111111111111111111111111111111111111",
      maxTimeoutSeconds: 300,
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      outputSchema: { input: { type: "http", method: "GET", discoverable: true } },
      extra: { name: "USDC", version: "2" },
    },
  ],
  x402Version: 2,
});

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

const SAMPLE_PAYMENT_PAYLOAD = {
  x402Version: 1,
  scheme: "exact",
  network: "base-sepolia",
  payload: {
    signature: "0x" + "a".repeat(130),
    authorization: {
      from: "0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895",
      to: "0x1111111111111111111111111111111111111111",
      value: "1000",
      validAfter: "0",
      validBefore: "1750000000",
      nonce: "0x" + "f".repeat(64),
    },
  },
};

describe("detectVersion", () => {
  it("returns 1 by default", () => {
    expect(detectVersion({})).toBe(1);
  });
  it("returns 2 when v2 request header is present", () => {
    expect(detectVersion({ "payment-signature": "..." })).toBe(2);
  });
  it("returns 2 when v2 response header is present", () => {
    expect(detectVersion({ "payment-response": "..." })).toBe(2);
  });
  it("returns 2 when body has x402Version=2", () => {
    expect(detectVersion({}, { x402Version: 2 })).toBe(2);
  });
  it("returns 1 when body has x402Version=1", () => {
    expect(detectVersion({}, { x402Version: 1 })).toBe(1);
  });
});

describe("findPaymentHeader", () => {
  it("prefers v1 X-PAYMENT", () => {
    const hit = findPaymentHeader({ "x-payment": "v1value", "payment-signature": "v2value" });
    expect(hit).toEqual({ name: "x-payment", value: "v1value", version: 1 });
  });
  it("falls back to v2 PAYMENT-SIGNATURE", () => {
    const hit = findPaymentHeader({ "payment-signature": "v2value" });
    expect(hit).toEqual({ name: "payment-signature", value: "v2value", version: 2 });
  });
  it("returns null when neither is present", () => {
    expect(findPaymentHeader({})).toBeNull();
  });
});

describe("findSettlementHeader", () => {
  it("prefers v1 X-PAYMENT-RESPONSE", () => {
    const hit = findSettlementHeader({
      "x-payment-response": "v1value",
      "payment-response": "v2value",
    });
    expect(hit).toEqual({ name: "x-payment-response", value: "v1value", version: 1 });
  });
  it("falls back to v2 PAYMENT-RESPONSE", () => {
    const hit = findSettlementHeader({ "payment-response": "v2value" });
    expect(hit).toEqual({ name: "payment-response", value: "v2value", version: 2 });
  });
  it("returns null when neither is present", () => {
    expect(findSettlementHeader({})).toBeNull();
  });
});

describe("parseChallengeBody", () => {
  it("parses a v1 challenge body", () => {
    const result = parseChallengeBody(V1_CHALLENGE_BODY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.x402Version).toBe(1);
    expect(result.value.requirements.scheme).toBe("exact");
    expect(result.value.requirements.network).toBe("base-sepolia");
    expect(result.value.requirements.maxAmountRequired).toBe("1000");
    expect(result.value.error).toBe("X-PAYMENT header is required");
  });

  it("parses a v2 challenge body", () => {
    const result = parseChallengeBody(V2_CHALLENGE_BODY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.x402Version).toBe(2);
    expect(result.value.requirements.scheme).toBe("exact");
  });

  it("rejects non-JSON body", () => {
    const result = parseChallengeBody("not json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/not JSON/);
  });

  it("rejects body missing accepts[]", () => {
    const result = parseChallengeBody(JSON.stringify({ x402Version: 1, error: "no accepts" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/accepts/);
  });

  it("rejects accepts entry missing required fields", () => {
    const result = parseChallengeBody(
      JSON.stringify({ x402Version: 1, accepts: [{ scheme: "exact" }] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/network/);
  });
});

describe("parsePaymentHeader", () => {
  it("parses a well-formed v1 payment header (base64 JSON)", () => {
    const headerValue = b64(SAMPLE_PAYMENT_PAYLOAD);
    const result = parsePaymentHeader(headerValue, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scheme).toBe("exact");
    expect(result.value.payload.authorization.value).toBe("1000");
    expect(result.value.payload.authorization.nonce).toMatch(/^0x[f]{64}$/);
  });

  it("parses a well-formed v2 payment header", () => {
    const v2Payload = { ...SAMPLE_PAYMENT_PAYLOAD, x402Version: 2 };
    const result = parsePaymentHeader(b64(v2Payload), 2);
    expect(result.ok).toBe(true);
  });

  it("rejects malformed base64", () => {
    const result = parsePaymentHeader("not!!!valid!!!base64", 1);
    expect(result.ok).toBe(false);
  });

  it("rejects v2 base64-of-non-JSON", () => {
    const result = parsePaymentHeader(Buffer.from("not json", "utf8").toString("base64"), 2);
    expect(result.ok).toBe(false);
  });

  it("rejects payload missing signature", () => {
    const broken = JSON.parse(JSON.stringify(SAMPLE_PAYMENT_PAYLOAD)) as {
      payload: Record<string, unknown>;
    };
    delete broken.payload.signature;
    const result = parsePaymentHeader(b64(broken), 2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/signature/);
  });
});

describe("parseSettlementHeader", () => {
  it("parses a well-formed success settlement header", () => {
    const headerValue = b64({
      success: true,
      transaction: "0x" + "c".repeat(64),
      network: "base-sepolia",
      payer: "0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895",
    });
    const result = parseSettlementHeader(headerValue);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.success).toBe(true);
    expect(result.value.transaction).toMatch(/^0x[c]{64}$/);
  });

  it("parses a verify-failure settlement header", () => {
    const headerValue = b64({
      isValid: false,
      invalidReason: "invalid_exact_evm_insufficient_balance",
      payer: "0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895",
    });
    const result = parseSettlementHeader(headerValue);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.isValid).toBe(false);
    expect(result.value.invalidReason).toBe("invalid_exact_evm_insufficient_balance");
  });

  it("rejects malformed base64", () => {
    const result = parseSettlementHeader("not!!!base64");
    expect(result.ok).toBe(false);
  });
});
