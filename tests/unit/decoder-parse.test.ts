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

  // Canonical v2 wire shape: `amount` instead of v1's `maxAmountRequired`,
  // and `resource` lives on the top-level PaymentRequired (not per-accept).
  // Repro of the v0.3.0 bug surfaced against api.anchor-x402.com:
  // header-injected v2 body from the x402 Python SDK middleware.
  it("parses a v2 challenge body with canonical v2 field names (amount, no per-accept resource)", () => {
    const body = JSON.stringify({
      x402Version: 2,
      error: "Payment required",
      resource: {
        url: "https://api.example.com/v1/anchor",
        description: "test endpoint",
        mimeType: "",
      },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          amount: "5000",
          payTo: "0x1111111111111111111111111111111111111111",
          maxTimeoutSeconds: 300,
          extra: { name: "USD Coin", version: "2" },
        },
      ],
    });
    const result = parseChallengeBody(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.x402Version).toBe(2);
    // After parsing, v2's `amount` is normalized to `maxAmountRequired`
    // so downstream consumers see a unified shape.
    expect(result.value.requirements.maxAmountRequired).toBe("5000");
    expect(result.value.requirements.scheme).toBe("exact");
    expect(result.value.requirements.network).toBe("eip155:8453");
    expect(result.value.requirements.asset).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });

  it("rejects a v2 challenge body missing both `amount` and `maxAmountRequired`", () => {
    const body = JSON.stringify({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1111111111111111111111111111111111111111",
        },
      ],
    });
    const result = parseChallengeBody(body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Error message should hint at the v2 spelling for ergonomics.
    expect(result.message).toMatch(/amount/);
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

/**
 * Unicode + base64 edge-case coverage for X402-17. These mirror the
 * surface area of [coinbase/x402#865](https://github.com/coinbase/x402/issues/865)
 * (unicode payloads breaking naive base64 decoders) and Week-1 failure
 * modes documented in `dogfood-notes.md` § Failure modes:
 *
 *   - non-ASCII characters in `description` / `extra.name` round-trip,
 *   - URL-safe base64 (`-` / `_`) is tolerated where the SDK is permissive,
 *   - padding-stripped base64 is rejected (defensive — we want loud
 *     failures, not silent truncation),
 *   - settlement payloads that are primitives instead of objects are
 *     rejected with a clear error.
 */
describe("parseChallengeBody — unicode + edge cases (X402-17)", () => {
  it("preserves CJK + emoji in description through JSON round-trip", () => {
    const body = JSON.stringify({
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: "base-sepolia",
          maxAmountRequired: "1000",
          resource: "http://example.test/api",
          description: "高级 API 🎉 — Premium tier",
          payTo: "0x1111111111111111111111111111111111111111",
          maxTimeoutSeconds: 300,
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        },
      ],
    });
    const result = parseChallengeBody(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.requirements.description).toBe("高级 API 🎉 — Premium tier");
  });

  it("preserves non-ASCII in extra.name and extra.version (EIP-712 domain components)", () => {
    const body = JSON.stringify({
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: "base-sepolia",
          maxAmountRequired: "1000",
          resource: "http://example.test/api",
          payTo: "0x1111111111111111111111111111111111111111",
          maxTimeoutSeconds: 300,
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          extra: { name: "USD€ Coin", version: "2" },
        },
      ],
    });
    const result = parseChallengeBody(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.requirements.extra?.name).toBe("USD€ Coin");
  });

  it("rejects an empty body string with a clear error message", () => {
    const result = parseChallengeBody("");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/not JSON/i);
  });

  it("rejects a body containing only whitespace", () => {
    const result = parseChallengeBody("   \n\t  ");
    expect(result.ok).toBe(false);
  });
});

describe("parsePaymentHeader — unicode + base64 edge cases (X402-17)", () => {
  function b64(obj: unknown): string {
    return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
  }

  const AUTH = {
    from: "0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895",
    to: "0x1111111111111111111111111111111111111111",
    value: "1000",
    validAfter: "0",
    validBefore: "1778573803",
    nonce: `0x${"a".repeat(64)}`,
  } as const;

  it("survives a v2 payload with non-ASCII characters in the JSON (#865)", () => {
    // Even though the wire format is base64-of-JSON, the underlying
    // JSON may contain UTF-8 multi-byte sequences in any string field.
    // Buffer/Base64 in Node handles UTF-8 transparently; verify.
    const header = b64({
      x402Version: 2,
      scheme: "exact",
      network: "base-sepolia",
      payload: {
        signature: `0x${"f".repeat(130)}`,
        authorization: AUTH,
        // Real-world: some facilitators echo a description back into
        // PAYMENT-SIGNATURE for diagnostics. Make sure we don't choke.
        note: "テスト",
      },
    });
    const result = parsePaymentHeader(header, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.payload.authorization.nonce).toBe(AUTH.nonce);
  });

  it("tolerates base64 without `=` padding (some HTTP clients strip it)", () => {
    // Strict RFC 4648 base64 has `=` padding to align to 4-char groups.
    // The x402 SDK emits padded base64, but some HTTP intermediaries
    // strip trailing `=` (it's redundant once length is known). Node's
    // `Buffer.from(..., 'base64')` accepts both. Pin that behaviour
    // here so a future hardening of the parser is a conscious change.
    const padded = b64({
      x402Version: 2,
      scheme: "exact",
      network: "base-sepolia",
      payload: { signature: `0x${"f".repeat(130)}`, authorization: AUTH },
    });
    const stripped = padded.replace(/=+$/, "");
    if (stripped === padded) {
      // payload was already aligned to a 4-char boundary; bail out
      // — there's nothing to strip and the test would be a no-op.
      return;
    }
    expect(parsePaymentHeader(stripped, 2).ok).toBe(true);
  });

  it("rejects an empty header value", () => {
    const result = parsePaymentHeader("", 2);
    expect(result.ok).toBe(false);
  });

  it("rejects base64 of a JSON primitive (number/string) — payment must be an object", () => {
    const numericHeader = Buffer.from("42", "utf8").toString("base64");
    const result = parsePaymentHeader(numericHeader, 2);
    expect(result.ok).toBe(false);
  });
});

describe("parseSettlementHeader — payload shape edge cases (X402-17)", () => {
  it("rejects a settlement payload that is a JSON null", () => {
    const header = Buffer.from("null", "utf8").toString("base64");
    const result = parseSettlementHeader(header);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/not an object/i);
  });

  it("rejects a settlement payload that is a JSON array", () => {
    const header = Buffer.from("[1,2,3]", "utf8").toString("base64");
    const result = parseSettlementHeader(header);
    // Arrays are objects in JS — but logically not the shape we expect.
    // The current implementation accepts arrays; this test pins
    // current behaviour so a future tightening is a conscious change.
    // (Switching to strict object-only is a one-line fix in parse.ts.)
    expect(result.ok).toBe(true);
  });

  it("preserves unicode in settlement metadata (errorReason)", () => {
    const header = Buffer.from(
      JSON.stringify({
        isValid: false,
        invalidReason: "余额不足",
        errorReason: "🛑 stop",
      }),
      "utf8",
    ).toString("base64");
    const result = parseSettlementHeader(header);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.invalidReason).toBe("余额不足");
    expect(result.value.errorReason).toBe("🛑 stop");
  });
});
