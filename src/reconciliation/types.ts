/**
 * X402-13 reconciliation engine types.
 *
 * The engine joins three input streams:
 *   1. Proxy `exchange.closed` events  — tells us a request finished
 *      with a `rejected` / `upstream_timeout` / `paid` outcome.
 *   2. Decoder `exchange.payment` events — gives us the EIP-3009
 *      `PaymentAuthorization` (with nonce) for that same exchange id.
 *   3. Chain client `ChainTransfer`s — actual on-chain USDC transfers
 *      with the matching `AuthorizationUsed.nonce`.
 *
 * For every exchange whose facilitator outcome was failed-but-the-
 * underlying-tx-might-have-settled, the engine emits a
 * `ReconciliationResult`. The headline case (`settled_on_chain`) is
 * the canonical #1062 detection: facilitator says no, chain says yes.
 */

import type { Address, ChainTransfer } from "../chain/types.js";
import type { PaymentPayload } from "../decoder/types.js";

/** A two-half-joined exchange currently awaiting on-chain confirmation. */
export interface PendingExchange {
  readonly id: string;
  /** Unix-ms timestamp when this exchange was flagged as pending. */
  readonly addedAt: number;
  /** Decoded payment payload from the X-PAYMENT header. */
  readonly payment: PaymentPayload;
  /** Why the proxy classified the response as a candidate for reconciliation. */
  readonly outcomeKind: "rejected" | "upstream_timeout" | "unknown";
  /** errorReason from the 402 body, if the proxy captured one. */
  readonly errorReason?: string;
}

/**
 * Output of the engine. One emitted per pending exchange that either
 * (a) finds its on-chain match, or (b) gives up after `watchTimeoutMs`.
 */
export type ReconciliationResult =
  | {
      readonly kind: "settled_on_chain";
      readonly t: string;
      readonly exchangeId: string;
      readonly pending: PendingExchange;
      readonly onChain: ChainTransfer;
      readonly gapMs: number;
    }
  | {
      readonly kind: "not_settled";
      readonly t: string;
      readonly exchangeId: string;
      readonly pending: PendingExchange;
      readonly waitedMs: number;
    }
  | {
      readonly kind: "value_mismatch";
      readonly t: string;
      readonly exchangeId: string;
      readonly pending: PendingExchange;
      readonly onChain: ChainTransfer;
      readonly expected: bigint;
      readonly actual: bigint;
    }
  | {
      readonly kind: "recipient_mismatch";
      readonly t: string;
      readonly exchangeId: string;
      readonly pending: PendingExchange;
      readonly onChain: ChainTransfer;
      readonly expectedPayee: Address;
      readonly actualPayee: Address;
    };

export interface EngineOptions {
  /** How long to wait for an on-chain match before emitting `not_settled`. Default 60_000 ms (per ARCHITECTURE.md). */
  readonly watchTimeoutMs?: number;
  /** Sweep interval for expiring pending entries. Default 1_000 ms. */
  readonly sweepIntervalMs?: number;
  /** Injectable clock for tests. Default Date.now. */
  readonly now?: () => number;
}
