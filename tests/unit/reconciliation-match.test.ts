import { describe, expect, it } from "vitest";
import { matchPendingAgainstTransfer } from "../../src/reconciliation/match.js";
import type { ChainTransfer } from "../../src/chain/types.js";
import type { PendingExchange } from "../../src/reconciliation/types.js";

const PAYER = "0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895" as const;
const PAYEE = "0x1111111111111111111111111111111111111111" as const;
const OTHER_PAYEE = "0x2222222222222222222222222222222222222222" as const;
const NONCE = `0x${"f".repeat(64)}` as const;
const OTHER_NONCE = `0x${"e".repeat(64)}` as const;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

function pending(): PendingExchange {
  return {
    id: "01HZX-test-exchange",
    addedAt: 1_000_000,
    outcomeKind: "rejected",
    payment: {
      x402Version: 1,
      scheme: "exact",
      network: "base-sepolia",
      payload: {
        signature: "[REDACTED]",
        authorization: {
          from: PAYER,
          to: PAYEE,
          value: "1000",
          validAfter: "0",
          validBefore: "1750000000",
          nonce: NONCE,
        },
      },
    },
  };
}

function transfer(over: Partial<ChainTransfer> = {}): ChainTransfer {
  return {
    txHash: `0x${"a".repeat(64)}`,
    blockNumber: 50n,
    blockTimestamp: 1_750_000_000,
    from: PAYER,
    to: PAYEE,
    value: 1_000n,
    tokenAddress: USDC,
    authorizationNonce: NONCE,
    ...over,
  };
}

describe("matchPendingAgainstTransfer", () => {
  it("returns 'exact' when (payer, payee, value, nonce) all match", () => {
    expect(matchPendingAgainstTransfer(pending(), transfer())).toEqual({ kind: "exact" });
  });

  it("is case-insensitive on addresses", () => {
    const t = transfer({
      from: PAYER.toLowerCase() as `0x${string}`,
      to: PAYEE.toUpperCase() as `0x${string}`,
    });
    expect(matchPendingAgainstTransfer(pending(), t)).toEqual({ kind: "exact" });
  });

  it("is case-insensitive on the nonce", () => {
    const t = transfer({ authorizationNonce: NONCE.toUpperCase() as `0x${string}` });
    expect(matchPendingAgainstTransfer(pending(), t)).toEqual({ kind: "exact" });
  });

  it("returns 'no_match' when the nonce differs", () => {
    expect(
      matchPendingAgainstTransfer(pending(), transfer({ authorizationNonce: OTHER_NONCE })),
    ).toEqual({
      kind: "no_match",
    });
  });

  it("returns 'no_match' when the authorizationNonce is undefined", () => {
    expect(
      matchPendingAgainstTransfer(pending(), transfer({ authorizationNonce: undefined })),
    ).toEqual({ kind: "no_match" });
  });

  it("returns 'no_match' when the payer differs (even if nonce matches)", () => {
    expect(matchPendingAgainstTransfer(pending(), transfer({ from: OTHER_PAYEE }))).toEqual({
      kind: "no_match",
    });
  });

  it("returns 'recipient_mismatch' when nonce + payer match but recipient differs", () => {
    const t = transfer({ to: OTHER_PAYEE });
    expect(matchPendingAgainstTransfer(pending(), t)).toEqual({ kind: "recipient_mismatch" });
  });

  it("returns 'value_mismatch' when nonce + payer + recipient match but value differs", () => {
    const t = transfer({ value: 2_000n });
    expect(matchPendingAgainstTransfer(pending(), t)).toEqual({
      kind: "value_mismatch",
      expected: 1_000n,
      actual: 2_000n,
    });
  });
});
