import { afterEach, describe, expect, it } from "vitest";
import { createReconciliationEngine } from "../../src/reconciliation/index.js";
import type { ChainTransfer } from "../../src/chain/types.js";
import type { DecodedEvent, PaymentPayload } from "../../src/decoder/types.js";
import type { ProxyEvent } from "../../src/proxy/types.js";
import type { PendingExchange, ReconciliationResult } from "../../src/reconciliation/types.js";
import type { ReconciliationEngine } from "../../src/reconciliation/engine.js";

const PAYER = "0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895" as const;
const PAYEE = "0x1111111111111111111111111111111111111111" as const;
const NONCE = `0x${"f".repeat(64)}` as const;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const EXCHANGE_ID = "01HZX-test-exchange";

function payment(over: Partial<PaymentPayload["payload"]["authorization"]> = {}): PaymentPayload {
  return {
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
        ...over,
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

function openedEvent(id: string): ProxyEvent {
  return {
    event: "exchange.opened",
    t: new Date().toISOString(),
    id,
    upstreamUrl: "http://upstream",
    request: { method: "GET", path: "/api/weather", headers: {} },
  };
}

function closedEvent(id: string, kind: "rejected" | "paid" | "upstream_timeout"): ProxyEvent {
  if (kind === "rejected") {
    return {
      event: "exchange.closed",
      t: new Date().toISOString(),
      id,
      response: {
        status: 402,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "invalid_exact_evm_insufficient_balance", accepts: [] }),
      },
      outcome: {
        kind: "rejected",
        status: 402,
        receivedAt: new Date().toISOString(),
        rawBody: JSON.stringify({ error: "invalid_exact_evm_insufficient_balance" }),
      },
      durationMs: 100,
    };
  }
  if (kind === "paid") {
    return {
      event: "exchange.closed",
      t: new Date().toISOString(),
      id,
      response: { status: 200, headers: {} },
      outcome: { kind: "paid", status: 200, receivedAt: new Date().toISOString() },
      durationMs: 100,
    };
  }
  return {
    event: "exchange.closed",
    t: new Date().toISOString(),
    id,
    response: { status: 502, headers: {} },
    outcome: { kind: "upstream_timeout", afterMs: 30_000, observedAt: new Date().toISOString() },
    durationMs: 30_000,
  };
}

function paymentEvent(id: string, p: PaymentPayload = payment()): DecodedEvent {
  return {
    event: "exchange.payment",
    t: new Date().toISOString(),
    id,
    x402Version: 1,
    payment: p,
  };
}

let engine: ReconciliationEngine | null = null;
afterEach(async () => {
  await engine?.close();
  engine = null;
});

describe("createReconciliationEngine", () => {
  it("flags an exchange as pending when proxy says 'rejected' and decoder has the payment", () => {
    engine = createReconciliationEngine();
    engine.ingestDecoderEvent(paymentEvent(EXCHANGE_ID));
    engine.ingestProxyEvent(openedEvent(EXCHANGE_ID));
    engine.ingestProxyEvent(closedEvent(EXCHANGE_ID, "rejected"));

    const pending = engine.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(EXCHANGE_ID);
    expect(pending[0]?.outcomeKind).toBe("rejected");
    expect(pending[0]?.errorReason).toBe("invalid_exact_evm_insufficient_balance");
  });

  it("does NOT flag a successful exchange even if both halves arrive", () => {
    engine = createReconciliationEngine();
    engine.ingestDecoderEvent(paymentEvent(EXCHANGE_ID));
    engine.ingestProxyEvent(closedEvent(EXCHANGE_ID, "paid"));
    expect(engine.pending()).toHaveLength(0);
  });

  it("emits `settled_on_chain` when a matching ChainTransfer arrives — the canonical #1062 case", async () => {
    let t = 1_000_000;
    engine = createReconciliationEngine({ now: () => t });

    // Subscribe before any events to avoid missing the emit.
    const results = collect(engine);

    engine.ingestDecoderEvent(paymentEvent(EXCHANGE_ID));
    engine.ingestProxyEvent(closedEvent(EXCHANGE_ID, "rejected"));
    expect(engine.pending()).toHaveLength(1);

    // Advance clock 5s then feed the matching on-chain transfer.
    t += 5_000;
    engine.ingestChainTransfer(transfer());

    const out = await results.next();
    expect(out.kind).toBe("settled_on_chain");
    if (out.kind !== "settled_on_chain") return;
    expect(out.exchangeId).toBe(EXCHANGE_ID);
    expect(out.gapMs).toBe(5_000);
    expect(out.onChain.txHash).toBe(transfer().txHash);
    expect(engine.pending()).toHaveLength(0);
  });

  it("emits `not_settled` after the watchTimeout elapses with no chain match", async () => {
    let t = 1_000_000;
    engine = createReconciliationEngine({
      now: () => t,
      watchTimeoutMs: 5_000,
      sweepIntervalMs: 50,
    });
    const results = collect(engine);

    engine.ingestDecoderEvent(paymentEvent(EXCHANGE_ID));
    engine.ingestProxyEvent(closedEvent(EXCHANGE_ID, "upstream_timeout"));
    expect(engine.pending()).toHaveLength(1);

    // Advance virtual clock past the watch window, wait for the sweep
    // to run at least once.
    t += 6_000;
    const out = await results.next();
    expect(out.kind).toBe("not_settled");
    if (out.kind !== "not_settled") return;
    expect(out.exchangeId).toBe(EXCHANGE_ID);
    expect(out.waitedMs).toBeGreaterThanOrEqual(5_000);
    expect(engine.pending()).toHaveLength(0);
  });

  it("emits `value_mismatch` when nonce matches but amount differs", async () => {
    let t = 1_000_000;
    engine = createReconciliationEngine({ now: () => t });
    const results = collect(engine);

    engine.ingestDecoderEvent(paymentEvent(EXCHANGE_ID));
    engine.ingestProxyEvent(closedEvent(EXCHANGE_ID, "rejected"));
    engine.ingestChainTransfer(transfer({ value: 9_999n }));

    const out = await results.next();
    expect(out.kind).toBe("value_mismatch");
    if (out.kind !== "value_mismatch") return;
    expect(out.expected).toBe(1_000n);
    expect(out.actual).toBe(9_999n);
  });

  it("emits `recipient_mismatch` when nonce + payer match but recipient differs", async () => {
    engine = createReconciliationEngine();
    const results = collect(engine);

    engine.ingestDecoderEvent(paymentEvent(EXCHANGE_ID));
    engine.ingestProxyEvent(closedEvent(EXCHANGE_ID, "rejected"));
    engine.ingestChainTransfer(transfer({ to: "0x3333333333333333333333333333333333333333" }));

    const out = await results.next();
    expect(out.kind).toBe("recipient_mismatch");
  });

  it("ignores chain transfers without an authorizationNonce", () => {
    engine = createReconciliationEngine();

    engine.ingestDecoderEvent(paymentEvent(EXCHANGE_ID));
    engine.ingestProxyEvent(closedEvent(EXCHANGE_ID, "rejected"));
    engine.ingestChainTransfer(transfer({ authorizationNonce: undefined }));

    // Pending must still be there — nothing was consumed.
    expect(engine.pending()).toHaveLength(1);
  });

  it("ignores chain transfers whose nonce doesn't match any pending entry", () => {
    engine = createReconciliationEngine();

    engine.ingestDecoderEvent(paymentEvent(EXCHANGE_ID));
    engine.ingestProxyEvent(closedEvent(EXCHANGE_ID, "rejected"));
    engine.ingestChainTransfer(transfer({ authorizationNonce: `0x${"e".repeat(64)}` }));

    expect(engine.pending()).toHaveLength(1);
  });

  it("handles arrival order: decoder event before proxy event vs vice versa", () => {
    engine = createReconciliationEngine();

    // decoder first
    engine.ingestDecoderEvent(paymentEvent("a"));
    engine.ingestProxyEvent(closedEvent("a", "rejected"));
    expect(engine.pending().find((p: PendingExchange) => p.id === "a")).toBeTruthy();

    // proxy first
    engine.ingestProxyEvent(closedEvent("b", "rejected"));
    engine.ingestDecoderEvent(paymentEvent("b"));
    expect(engine.pending().find((p: PendingExchange) => p.id === "b")).toBeTruthy();
  });
});

/** Helper that converts the engine's AsyncIterable into a one-shot .next() consumer. */
function collect(engine: ReconciliationEngine): {
  next(): Promise<ReconciliationResult>;
} {
  const sub = engine.results();
  const iter = sub[Symbol.asyncIterator]();
  return {
    async next() {
      const { value, done } = await iter.next();
      if (done) throw new Error("results stream closed unexpectedly");
      return value;
    },
  };
}
