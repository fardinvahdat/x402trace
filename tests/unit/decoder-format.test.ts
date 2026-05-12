import { describe, expect, it } from "vitest";
import { formatHuman, formatJson } from "../../src/decoder/format.js";
import type { DecodedEvent } from "../../src/decoder/types.js";

const T = "2026-06-15T14:21:03.000Z";
const ID = "01234567-89ab-cdef-0123-456789abcdef";

const CHALLENGE_EVENT: DecodedEvent = {
  event: "exchange.challenge",
  t: T,
  id: ID,
  x402Version: 1,
  challenge: {
    scheme: "exact",
    network: "base-sepolia",
    maxAmountRequired: "1000",
    resource: "http://localhost/x",
    payTo: "0x1111111111111111111111111111111111111111",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
  raw402Error: "X-PAYMENT header is required",
};

const PAYMENT_EVENT: DecodedEvent = {
  event: "exchange.payment",
  t: T,
  id: ID,
  x402Version: 1,
  payment: {
    x402Version: 1,
    scheme: "exact",
    network: "base-sepolia",
    payload: {
      signature: "[REDACTED]",
      authorization: {
        from: "0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895",
        to: "0x1111111111111111111111111111111111111111",
        value: "1000",
        validAfter: "0",
        validBefore: "1750000000",
        nonce: "0x" + "f".repeat(64),
      },
    },
  },
};

const SETTLEMENT_EVENT: DecodedEvent = {
  event: "exchange.settlement",
  t: T,
  id: ID,
  settlement: {
    success: true,
    transaction: "0x" + "c".repeat(64),
    network: "base-sepolia",
    payer: "0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895",
  },
};

const ERROR_EVENT: DecodedEvent = {
  event: "decoder.error",
  t: T,
  id: ID,
  stage: "challenge",
  message: "challenge body is not JSON",
};

describe("formatHuman", () => {
  it("renders a challenge in one readable line", () => {
    const line = formatHuman(CHALLENGE_EVENT);
    expect(line).toContain("402 challenge");
    expect(line).toContain("v1");
    expect(line).toContain("exact/base-sepolia");
    expect(line).toContain("amount=1000");
    expect(line).toContain("payTo=0x1111…1111");
    expect(line).toContain("(error=X-PAYMENT header is required)");
  });

  it("renders a payment with shortened addresses + nonce", () => {
    const line = formatHuman(PAYMENT_EVENT);
    expect(line).toContain("X-PAYMENT");
    expect(line).toContain("from=0xADEe…B895");
    expect(line).toContain("to=0x1111…1111");
    expect(line).toContain("value=1000");
  });

  it("renders a success settlement with ✓ marker and tx hash", () => {
    const line = formatHuman(SETTLEMENT_EVENT);
    expect(line).toContain("✓ success");
    // short() truncates to 8 chars total: "0x" + 6 c's.
    expect(line).toContain("tx=0xcccccc…");
  });

  it("renders a decoder error with stage + message", () => {
    const line = formatHuman(ERROR_EVENT);
    expect(line).toContain("decoder.error");
    expect(line).toContain("stage=challenge");
    expect(line).toContain('message="challenge body is not JSON"');
  });
});

describe("formatJson", () => {
  it("produces a single line of valid JSON", () => {
    const line = formatJson(CHALLENGE_EVENT);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual(CHALLENGE_EVENT);
  });
});
