import { describe, expect, it } from "vitest";
import { createColorizer } from "../../src/cli/color.js";
import { formatResultHuman, formatResultJson } from "../../src/cli/format-result.js";
import type { PendingExchange, ReconciliationResult } from "../../src/reconciliation/types.js";
import type { ChainTransfer } from "../../src/chain/types.js";

const PAYER = "0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895" as const;
const PAYEE = "0x1111111111111111111111111111111111111111" as const;
const NONCE = `0x${"a".repeat(64)}` as const;
const TX = `0x${"b".repeat(64)}` as const;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

const noColor = createColorizer({ enabled: false });

function basePending(): PendingExchange {
  return {
    id: "01HZX-test",
    addedAt: 1_700_000_000_000,
    outcomeKind: "rejected",
    errorReason: "invalid_exact_evm_insufficient_balance",
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

function baseTransfer(): ChainTransfer {
  return {
    txHash: TX,
    blockNumber: 12_345_678n,
    blockTimestamp: 1_700_000_001,
    from: PAYER,
    to: PAYEE,
    value: 1_000n,
    tokenAddress: USDC,
    authorizationNonce: NONCE,
  };
}

describe("formatResultHuman", () => {
  it("renders settled_on_chain with the canonical headline + key fields", () => {
    const result: ReconciliationResult = {
      kind: "settled_on_chain",
      t: "2026-05-12T00:00:00.000Z",
      exchangeId: "01HZX-test",
      pending: basePending(),
      onChain: baseTransfer(),
      gapMs: 4_200,
    };
    const line = formatResultHuman(result, noColor);
    expect(line).toContain("RECONCILED");
    expect(line).toContain("settled-but-server-thinks-not");
    expect(line).toContain("gap=4200ms");
    expect(line).toContain("value=1000");
    expect(line).toContain("id=01HZX-test");
  });

  it("renders not_settled with the green-path headline", () => {
    const result: ReconciliationResult = {
      kind: "not_settled",
      t: "2026-05-12T00:00:00.000Z",
      exchangeId: "01HZX-test",
      pending: basePending(),
      waitedMs: 60_000,
    };
    const line = formatResultHuman(result, noColor);
    expect(line).toContain("NOT_SETTLED");
    expect(line).toContain("facilitator was right");
    expect(line).toContain("waited=60000ms");
    expect(line).toContain("reason=invalid_exact_evm_insufficient_balance");
  });

  it("renders value_mismatch with expected/actual", () => {
    const result: ReconciliationResult = {
      kind: "value_mismatch",
      t: "2026-05-12T00:00:00.000Z",
      exchangeId: "01HZX-test",
      pending: basePending(),
      onChain: baseTransfer(),
      expected: 1_000n,
      actual: 2_000n,
    };
    const line = formatResultHuman(result, noColor);
    expect(line).toContain("VALUE_MISMATCH");
    expect(line).toContain("expected=1000");
    expect(line).toContain("actual=2000");
  });

  it("renders recipient_mismatch with both addresses", () => {
    const result: ReconciliationResult = {
      kind: "recipient_mismatch",
      t: "2026-05-12T00:00:00.000Z",
      exchangeId: "01HZX-test",
      pending: basePending(),
      onChain: baseTransfer(),
      expectedPayee: PAYEE,
      actualPayee: "0x2222222222222222222222222222222222222222",
    };
    const line = formatResultHuman(result, noColor);
    expect(line).toContain("RECIPIENT_MISMATCH");
    expect(line).toContain("0x1111…1111");
    expect(line).toContain("0x2222…2222");
  });

  it("includes ANSI escapes when colour is enabled", () => {
    const color = createColorizer({ enabled: true });
    const result: ReconciliationResult = {
      kind: "settled_on_chain",
      t: "2026-05-12T00:00:00.000Z",
      exchangeId: "01HZX-test",
      pending: basePending(),
      onChain: baseTransfer(),
      gapMs: 0,
    };
    const line = formatResultHuman(result, color);
    expect(line.includes("\x1b[")).toBe(true);
  });
});

describe("formatResultJson", () => {
  it("round-trips through JSON.parse, with bigints coerced to strings", () => {
    const result: ReconciliationResult = {
      kind: "settled_on_chain",
      t: "2026-05-12T00:00:00.000Z",
      exchangeId: "01HZX-test",
      pending: basePending(),
      onChain: baseTransfer(),
      gapMs: 31,
    };
    const line = formatResultJson(result);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.kind).toBe("settled_on_chain");
    expect((parsed.onChain as Record<string, unknown>).value).toBe("1000");
    expect((parsed.onChain as Record<string, unknown>).blockNumber).toBe("12345678");
  });

  it("never contains an unescaped newline (one JSON object per line)", () => {
    const result: ReconciliationResult = {
      kind: "not_settled",
      t: "2026-05-12T00:00:00.000Z",
      exchangeId: "01HZX-test",
      pending: basePending(),
      waitedMs: 60_000,
    };
    const line = formatResultJson(result);
    expect(line.includes("\n")).toBe(false);
  });
});
