/**
 * X402-13 reconciliation engine.
 *
 * Joins proxy + decoder + chain streams into a single ReconciliationResult
 * stream. Maintains an in-memory pending set keyed by exchange id;
 * sweeps it periodically to emit `not_settled` for entries that don't
 * find their on-chain match within `watchTimeoutMs`.
 *
 * Per ARCHITECTURE.md § Reconciliation engine:
 *
 *   "Holds an in-memory pending set of `PaymentExchange`s whose
 *    `outcome.kind` is `rejected` or `upstream_timeout`. … On a match:
 *    emits a `ReconciliationResult` … and removes from pending. On no
 *    match after `--watch-timeout-ms` (default 60000): emits
 *    `kind: 'not_settled'` and removes from pending."
 */

import type { ChainTransfer } from "../chain/types.js";
import type { DecodedEvent, PaymentPayload } from "../decoder/types.js";
import type { ProxyEvent } from "../proxy/types.js";
import { createEventBus } from "../proxy/event-bus.js";
import { matchPendingAgainstTransfer } from "./match.js";
import type { EngineOptions, PendingExchange, ReconciliationResult } from "./types.js";

const DEFAULT_WATCH_TIMEOUT_MS = 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 1_000;

interface PartialJoin {
  payment?: PaymentPayload;
  outcome?: {
    kind: PendingExchange["outcomeKind"] | "paid";
    errorReason?: string;
  };
}

export interface ReconciliationEngine {
  ingestProxyEvent(event: ProxyEvent): void;
  ingestDecoderEvent(event: DecodedEvent): void;
  ingestChainTransfer(transfer: ChainTransfer): void;
  /** Snapshot of currently-pending exchanges (for diagnostics / tests). */
  pending(): readonly PendingExchange[];
  /** AsyncIterable of every result emitted from now onward. */
  results(): AsyncIterable<ReconciliationResult> & { unsubscribe(): void };
  /**
   * Run the expiry sweep once. Useful for offline replay (X402-14
   * `inspect`) where a virtual clock advances faster than the
   * `sweepIntervalMs` real-time interval can catch.
   */
  tick(): void;
  /** Stop sweeping; resolve any subscriber awaits. */
  close(): Promise<void>;
}

export function createReconciliationEngine(opts: EngineOptions = {}): ReconciliationEngine {
  const watchTimeoutMs = opts.watchTimeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS;
  const sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const now = opts.now ?? (() => Date.now());

  const partial = new Map<string, PartialJoin>();
  const pending = new Map<string, PendingExchange>();
  const resultBus = createEventBus<ReconciliationResult>();

  const promote = (id: string): void => {
    const half = partial.get(id);
    if (!half || !half.payment || !half.outcome) return;
    // Only flag reconcile-worthy outcomes; success/paid is fine.
    if (half.outcome.kind === "paid") {
      partial.delete(id);
      return;
    }
    pending.set(id, {
      id,
      addedAt: now(),
      payment: half.payment,
      outcomeKind: half.outcome.kind,
      ...(half.outcome.errorReason ? { errorReason: half.outcome.errorReason } : {}),
    });
    partial.delete(id);
  };

  const ingestProxyEvent = (event: ProxyEvent): void => {
    if (event.event === "exchange.closed") {
      const half = partial.get(event.id) ?? {};
      let kind: PartialJoin["outcome"];
      switch (event.outcome.kind) {
        case "paid":
          kind = { kind: "paid" };
          break;
        case "rejected":
          kind = {
            kind: "rejected",
            ...(event.outcome.rawBody
              ? { errorReason: extractErrorReason(event.outcome.rawBody) }
              : {}),
          };
          break;
        case "upstream_timeout":
          kind = { kind: "upstream_timeout" };
          break;
        case "unknown":
        default:
          kind = { kind: "unknown" };
      }
      half.outcome = kind;
      partial.set(event.id, half);
      promote(event.id);
    }
    // `exchange.opened` and `proxy.error` are observed but don't gate
    // reconciliation — the payment + closed events are the join points.
  };

  const ingestDecoderEvent = (event: DecodedEvent): void => {
    if (event.event === "exchange.payment") {
      const half = partial.get(event.id) ?? {};
      half.payment = event.payment;
      partial.set(event.id, half);
      promote(event.id);
    }
    // `exchange.challenge` and `exchange.settlement` are not required
    // for matching. They could be persisted in the future to enrich
    // ReconciliationResult.pending.
  };

  const ingestChainTransfer = (transfer: ChainTransfer): void => {
    if (!transfer.authorizationNonce) {
      // Without a nonce we can't safely match; ignore.
      return;
    }
    for (const [id, p] of pending) {
      const result = matchPendingAgainstTransfer(p, transfer);
      if (result.kind === "no_match") continue;

      const t = new Date(now()).toISOString();
      const gapMs = now() - p.addedAt;

      if (result.kind === "exact") {
        resultBus.emit({
          kind: "settled_on_chain",
          t,
          exchangeId: id,
          pending: p,
          onChain: transfer,
          gapMs,
        });
      } else if (result.kind === "value_mismatch") {
        resultBus.emit({
          kind: "value_mismatch",
          t,
          exchangeId: id,
          pending: p,
          onChain: transfer,
          expected: result.expected,
          actual: result.actual,
        });
      } else if (result.kind === "recipient_mismatch") {
        resultBus.emit({
          kind: "recipient_mismatch",
          t,
          exchangeId: id,
          pending: p,
          onChain: transfer,
          expectedPayee: p.payment.payload.authorization.to as `0x${string}`,
          actualPayee: transfer.to,
        });
      }
      pending.delete(id);
      return; // one match per chain transfer
    }
  };

  const sweep = (): void => {
    const cutoff = now() - watchTimeoutMs;
    for (const [id, p] of pending) {
      if (p.addedAt <= cutoff) {
        resultBus.emit({
          kind: "not_settled",
          t: new Date(now()).toISOString(),
          exchangeId: id,
          pending: p,
          waitedMs: now() - p.addedAt,
        });
        pending.delete(id);
      }
    }
  };

  const interval = setInterval(sweep, sweepIntervalMs);
  // Don't let the timer keep the Node event loop alive on its own.
  interval.unref?.();

  return {
    ingestProxyEvent,
    ingestDecoderEvent,
    ingestChainTransfer,
    pending: () => Array.from(pending.values()),
    results: () => resultBus.subscribe(),
    tick: sweep,
    async close() {
      clearInterval(interval);
    },
  };
}

/**
 * Extract a top-level `error` string from a 402 response body if it
 * looks like x402-shaped JSON. Returns the string or undefined.
 */
function extractErrorReason(rawBody: string): string | undefined {
  try {
    const parsed = JSON.parse(rawBody) as { error?: unknown };
    if (typeof parsed?.error === "string") return parsed.error;
  } catch {
    // not JSON; skip
  }
  return undefined;
}
