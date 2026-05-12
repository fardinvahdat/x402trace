/**
 * Renders `ReconciliationResult`s for stdout. The JSONL log is the
 * canonical record; this is the human-facing line per [SPEC.md § 3 user
 * flow](../../SPEC.md#3-user-flow) — the `RECONCILED ⚠
 * settled-but-server-thinks-not` headline for the canonical #1062
 * detection.
 *
 * `formatJson` is `JSON.stringify(result)` so output is grep-friendly
 * (X402-14 acceptance criterion).
 */

import type { ReconciliationResult } from "../reconciliation/types.js";
import type { Colorizer } from "./color.js";

export function formatResultHuman(result: ReconciliationResult, color: Colorizer): string {
  const stamp = color.paint("dim", `[${result.t}]`);
  const id = short(result.exchangeId);
  switch (result.kind) {
    case "settled_on_chain": {
      const headline = color.paint("yellow", "RECONCILED ⚠ settled-but-server-thinks-not");
      const tx = color.paint("cyan", short(result.onChain.txHash, 10));
      const auth = result.pending.payment.payload.authorization;
      return `${stamp} ${headline} id=${id} tx=${tx} value=${auth.value} payer=${shortAddr(auth.from)} → payee=${shortAddr(auth.to)} gap=${result.gapMs}ms`;
    }
    case "not_settled": {
      const headline = color.paint("green", "NOT_SETTLED ✓ facilitator was right");
      const auth = result.pending.payment.payload.authorization;
      const reason = result.pending.errorReason ? ` reason=${result.pending.errorReason}` : "";
      return `${stamp} ${headline} id=${id} payer=${shortAddr(auth.from)} value=${auth.value} waited=${result.waitedMs}ms${reason}`;
    }
    case "value_mismatch": {
      const headline = color.paint(
        "red",
        "VALUE_MISMATCH ⚠ on-chain transfer differs from authorized value",
      );
      return `${stamp} ${headline} id=${id} tx=${short(result.onChain.txHash, 10)} expected=${result.expected} actual=${result.actual}`;
    }
    case "recipient_mismatch": {
      const headline = color.paint(
        "red",
        "RECIPIENT_MISMATCH ⚠ on-chain transfer paid the wrong address",
      );
      return `${stamp} ${headline} id=${id} tx=${short(result.onChain.txHash, 10)} expected=${shortAddr(result.expectedPayee)} actual=${shortAddr(result.actualPayee)}`;
    }
  }
}

/**
 * JSON-stringify a `ReconciliationResult`. `bigint`s in the embedded
 * `ChainTransfer` (blockNumber, value) and the value_mismatch
 * expected/actual are coerced to strings — JSON has no bigint and we
 * want lossless representation downstream.
 */
export function formatResultJson(result: ReconciliationResult): string {
  return JSON.stringify(result, bigintReplacer);
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function short(value: string, head = 8): string {
  if (value.length <= head + 4) return value;
  return `${value.slice(0, head)}…`;
}

function shortAddr(value: string): string {
  if (!value.startsWith("0x") || value.length < 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
