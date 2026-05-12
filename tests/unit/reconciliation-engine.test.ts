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

/**
 * X402-17 edge-case coverage: paths the existing 9 lifecycle tests
 * leave on the table.
 *
 * The engine has three places it can silently misbehave:
 *   1. `extractErrorReason` — runs JSON.parse on every 402 rawBody.
 *      Non-JSON / missing-error rawBodies must not throw or populate
 *      `errorReason` with garbage.
 *   2. The `unknown` proxy outcome branch — the ARCHITECTURE only
 *      names rejected / upstream_timeout, but the proxy emits
 *      `unknown` on non-2xx-non-402 statuses and the engine must
 *      pend those too (X402-15 demo with DEMO_FAIL_AFTER_SLEEP=1
 *      hits this path).
 *   3. Chain-transfer-first arrival — if the chain client's poller
 *      fires before the proxy event drains, the engine must not
 *      crash; the transfer is just ignored (no pending entry to match).
 */
describe("createReconciliationEngine — extractErrorReason edge cases (X402-17)", () => {
  it("handles a rejected outcome whose rawBody is not JSON without populating errorReason", () => {
    const engine = createReconciliationEngine({ watchTimeoutMs: 1_000 });
    engine.ingestDecoderEvent(paymentEvent(EXCHANGE_ID));
    engine.ingestProxyEvent({
      event: "exchange.closed",
      t: new Date().toISOString(),
      id: EXCHANGE_ID,
      response: { status: 402, headers: {}, body: "<html>nope</html>" },
      outcome: {
        kind: "rejected",
        status: 402,
        receivedAt: new Date().toISOString(),
        rawBody: "<html>nope</html>",
      },
      durationMs: 7,
    });
    const pending = engine.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.errorReason).toBeUndefined();
    void engine.close();
  });

  it("handles a rejected outcome whose rawBody is JSON but missing `error`", () => {
    const engine = createReconciliationEngine({ watchTimeoutMs: 1_000 });
    engine.ingestDecoderEvent(paymentEvent(EXCHANGE_ID));
    engine.ingestProxyEvent({
      event: "exchange.closed",
      t: new Date().toISOString(),
      id: EXCHANGE_ID,
      response: {
        status: 402,
        headers: {},
        body: JSON.stringify({ other: "field" }),
      },
      outcome: {
        kind: "rejected",
        status: 402,
        receivedAt: new Date().toISOString(),
        rawBody: JSON.stringify({ other: "field" }),
      },
      durationMs: 7,
    });
    const pending = engine.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.errorReason).toBeUndefined();
    void engine.close();
  });

  it("handles a rejected outcome with no rawBody at all", () => {
    const engine = createReconciliationEngine({ watchTimeoutMs: 1_000 });
    engine.ingestDecoderEvent(paymentEvent(EXCHANGE_ID));
    engine.ingestProxyEvent({
      event: "exchange.closed",
      t: new Date().toISOString(),
      id: EXCHANGE_ID,
      response: { status: 402, headers: {} },
      outcome: { kind: "rejected", status: 402, receivedAt: new Date().toISOString() },
      durationMs: 7,
    });
    expect(engine.pending()).toHaveLength(1);
    void engine.close();
  });
});

describe("createReconciliationEngine — `unknown` outcome branch (X402-17)", () => {
  it("pends an exchange whose proxy outcome is `unknown` (e.g. 500/503 post-settle)", () => {
    // X402-15's DEMO_FAIL_AFTER_SLEEP path hits this exact branch:
    // server settled, then returned 500 → proxy classifies the
    // response as `unknown`. The engine must still pend (so the
    // chain match is possible) — the X402-13 ARCHITECTURE table only
    // names rejected + upstream_timeout, but the implementation
    // promotes `unknown` too.
    const engine = createReconciliationEngine({ watchTimeoutMs: 1_000 });
    engine.ingestDecoderEvent(paymentEvent(EXCHANGE_ID));
    engine.ingestProxyEvent({
      event: "exchange.closed",
      t: new Date().toISOString(),
      id: EXCHANGE_ID,
      response: { status: 500, headers: {}, body: "Internal Server Error" },
      outcome: { kind: "unknown", status: 500, receivedAt: new Date().toISOString() },
      durationMs: 11_500,
    });
    const pending = engine.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.outcomeKind).toBe("unknown");
    void engine.close();
  });
});

describe("createReconciliationEngine — chain-transfer arrival edge cases (X402-17)", () => {
  it("ignores a chain transfer whose nonce doesn't match any pending entry (no crash)", () => {
    // The chain client emits Transfer events for the whole network;
    // most of them are unrelated to our exchanges. The engine must
    // shrug them off cheaply.
    const engine = createReconciliationEngine({ watchTimeoutMs: 1_000 });
    engine.ingestChainTransfer(transfer({ authorizationNonce: `0x${"e".repeat(64)}` }));
    expect(engine.pending()).toHaveLength(0); // never had one
    void engine.close();
  });

  it("a chain transfer arriving BEFORE the payment+outcome join is a no-op (no crash, no pre-match)", () => {
    // Race: chain poll fires before the proxy events drain. The
    // engine has no pending entry to match against, so the transfer
    // is silently dropped. Once the proxy/decoder events arrive
    // later, the entry pends — but the engine doesn't have a
    // back-buffer of unconsumed chain transfers, so no match occurs.
    // This pins the v0.1 contract: chain transfers seen before pending
    // are lost. A future hardening could buffer them (recorded as a
    // known v0.2 consideration).
    const engine = createReconciliationEngine({ watchTimeoutMs: 1_000 });
    engine.ingestChainTransfer(transfer());
    engine.ingestDecoderEvent(paymentEvent(EXCHANGE_ID));
    engine.ingestProxyEvent(closedEvent(EXCHANGE_ID, "rejected"));
    expect(engine.pending()).toHaveLength(1); // pended, but unmatched
    void engine.close();
  });

  it("after a settled_on_chain emission, a second matching chain transfer is a no-op", async () => {
    // Real-world: re-orgs or duplicate Transfer events can fire the
    // same logical settlement twice. The engine removes the pending
    // entry on first match, so the second transfer finds nothing.
    const results: ReconciliationResult[] = [];
    const engine = createReconciliationEngine({ watchTimeoutMs: 1_000 });
    const sub = engine.results();
    const collector = (async () => {
      for await (const r of sub) results.push(r);
    })();

    engine.ingestDecoderEvent(paymentEvent(EXCHANGE_ID));
    engine.ingestProxyEvent(closedEvent(EXCHANGE_ID, "rejected"));
    engine.ingestChainTransfer(transfer({ txHash: `0x${"1".repeat(64)}` }));
    engine.ingestChainTransfer(transfer({ txHash: `0x${"2".repeat(64)}` }));

    await new Promise((r) => setTimeout(r, 10));
    sub.unsubscribe();
    await engine.close();
    await collector;

    expect(results).toHaveLength(1);
    expect(results[0]?.kind).toBe("settled_on_chain");
    if (results[0]?.kind === "settled_on_chain") {
      expect(results[0].onChain.txHash).toBe(`0x${"1".repeat(64)}`);
    }
  });
});
