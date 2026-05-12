/**
 * Unit tests for the streaming decoder — `createDecoder().decode()`.
 *
 * The parser primitives in `parse.ts` are unit-tested in
 * `decoder-parse.test.ts`. This file exercises the *dispatch* logic in
 * `decoder.ts` that turns a `ProxyEvent` into 0..N `DecodedEvent`s:
 *
 *   - which header branches fire on which event shape,
 *   - what `decoder.error` looks like when each parser fails,
 *   - the `outcome.rawPaymentResponseHeader` fallback (proxy already
 *     extracted the X-PAYMENT-RESPONSE header at classify time),
 *   - the `proxy.error` passthrough.
 *
 * These are the paths that break silently in production — a malformed
 * settlement header could swallow itself if we don't surface
 * `decoder.error`, and a fallback header path that doesn't trigger
 * would lose every paid settlement record on hosts where the proxy
 * normalizes headers eagerly.
 */
import { describe, expect, it } from "vitest";
import { createDecoder } from "../../src/decoder/index.js";
import type { ProxyEvent } from "../../src/proxy/types.js";

function makeOpenedEvent(headers: Record<string, string> = {}): ProxyEvent {
  return {
    event: "exchange.opened",
    t: "2026-05-12T00:00:00.000Z",
    id: "01HZX-test",
    upstreamUrl: "http://upstream.test",
    request: {
      method: "GET",
      path: "/api/weather",
      headers,
      body: "",
    },
  };
}

function makeClosed402(body: string): ProxyEvent {
  return {
    event: "exchange.closed",
    t: "2026-05-12T00:00:00.000Z",
    id: "01HZX-test",
    response: { status: 402, headers: {}, body },
    outcome: {
      kind: "rejected",
      status: 402,
      receivedAt: "2026-05-12T00:00:00.000Z",
      rawBody: body,
    },
    durationMs: 7,
  };
}

function makeClosed200(
  responseHeaders: Record<string, string>,
  outcomeRawHeader?: string,
): ProxyEvent {
  return {
    event: "exchange.closed",
    t: "2026-05-12T00:00:00.000Z",
    id: "01HZX-test",
    response: { status: 200, headers: responseHeaders, body: "{}" },
    outcome: {
      kind: "paid",
      status: 200,
      receivedAt: "2026-05-12T00:00:00.000Z",
      ...(outcomeRawHeader ? { rawPaymentResponseHeader: outcomeRawHeader } : {}),
    },
    durationMs: 11,
  };
}

const VALID_402_BODY = JSON.stringify({
  x402Version: 1,
  error: "X-PAYMENT header is required",
  accepts: [
    {
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "1000",
      resource: "http://upstream.test/api/weather",
      payTo: "0x1111111111111111111111111111111111111111",
      maxTimeoutSeconds: 300,
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      extra: { name: "USDC", version: "2" },
    },
  ],
});

const VALID_SETTLEMENT_B64 = Buffer.from(
  JSON.stringify({
    success: true,
    transaction: "0xabc",
    network: "base-sepolia",
    payer: "0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895",
  }),
).toString("base64");

describe("createDecoder().decode — happy paths", () => {
  it("emits nothing for an opened event with no x402 headers", () => {
    const decoder = createDecoder();
    const out = decoder.decode(makeOpenedEvent({}));
    expect(out).toEqual([]);
  });

  it("emits exchange.challenge with the raw402Error string when present", () => {
    const decoder = createDecoder();
    const out = decoder.decode(makeClosed402(VALID_402_BODY));
    expect(out).toHaveLength(1);
    expect(out[0]?.event).toBe("exchange.challenge");
    if (out[0]?.event === "exchange.challenge") {
      expect(out[0].raw402Error).toBe("X-PAYMENT header is required");
      expect(out[0].x402Version).toBe(1);
    }
  });

  it("omits raw402Error when the 402 body has no top-level error", () => {
    const body = JSON.stringify({
      x402Version: 1,
      accepts: [JSON.parse(VALID_402_BODY).accepts[0]],
    });
    const decoder = createDecoder();
    const out = decoder.decode(makeClosed402(body));
    expect(out[0]?.event).toBe("exchange.challenge");
    if (out[0]?.event === "exchange.challenge") {
      expect(out[0].raw402Error).toBeUndefined();
    }
  });
});

describe("createDecoder().decode — settlement extraction", () => {
  it("parses settlement from X-PAYMENT-RESPONSE response header", () => {
    const decoder = createDecoder();
    const out = decoder.decode(makeClosed200({ "x-payment-response": VALID_SETTLEMENT_B64 }));
    expect(out).toHaveLength(1);
    expect(out[0]?.event).toBe("exchange.settlement");
    if (out[0]?.event === "exchange.settlement") {
      expect(out[0].settlement.success).toBe(true);
      expect(out[0].settlement.transaction).toBe("0xabc");
    }
  });

  it("emits decoder.error when the X-PAYMENT-RESPONSE header is malformed", () => {
    const decoder = createDecoder();
    const out = decoder.decode(makeClosed200({ "x-payment-response": "!!!not base64!!!" }));
    expect(out).toHaveLength(1);
    expect(out[0]?.event).toBe("decoder.error");
    if (out[0]?.event === "decoder.error") {
      expect(out[0].stage).toBe("settlement");
      expect(out[0].id).toBe("01HZX-test");
    }
  });

  it("falls back to outcome.rawPaymentResponseHeader when response headers are missing it", () => {
    // Some proxy adapters strip hop-by-hop headers / normalise; the
    // proxy stamps the raw header on the outcome at classify time as
    // a backup. The decoder must honour it.
    const decoder = createDecoder();
    const event = makeClosed200({}, VALID_SETTLEMENT_B64);
    const out = decoder.decode(event);
    expect(out).toHaveLength(1);
    expect(out[0]?.event).toBe("exchange.settlement");
  });

  it("silently drops a malformed rawPaymentResponseHeader fallback (it's a best-effort backup)", () => {
    const decoder = createDecoder();
    const event = makeClosed200({}, "!!!not base64!!!");
    const out = decoder.decode(event);
    // Unlike the primary header path, the fallback intentionally
    // doesn't emit decoder.error — the primary path already had its
    // chance and produced nothing, so the proxy's backup is best-effort.
    expect(out).toEqual([]);
  });
});

describe("createDecoder().decode — challenge errors", () => {
  it("emits decoder.error when the 402 body isn't JSON", () => {
    const decoder = createDecoder();
    const out = decoder.decode(makeClosed402("<html>not json</html>"));
    expect(out).toHaveLength(1);
    expect(out[0]?.event).toBe("decoder.error");
    if (out[0]?.event === "decoder.error") {
      expect(out[0].stage).toBe("challenge");
    }
  });

  it("does not emit anything for a 402 with no body (defensive — the proxy should always set one)", () => {
    const decoder = createDecoder();
    const event: ProxyEvent = {
      event: "exchange.closed",
      t: "2026-05-12T00:00:00.000Z",
      id: "01HZX-test",
      response: { status: 402, headers: {} },
      outcome: { kind: "rejected", status: 402, receivedAt: "2026-05-12T00:00:00.000Z" },
      durationMs: 7,
    };
    expect(decoder.decode(event)).toEqual([]);
  });
});

describe("createDecoder().decode — proxy.error passthrough", () => {
  it("re-emits proxy.error as decoder.error so single-bus subscribers see it", () => {
    const decoder = createDecoder();
    const out = decoder.decode({
      event: "proxy.error",
      t: "2026-05-12T00:00:00.000Z",
      id: "01HZX-test",
      message: "upstream socket hangup",
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.event).toBe("decoder.error");
    if (out[0]?.event === "decoder.error") {
      expect(out[0].id).toBe("01HZX-test");
      expect(out[0].message).toContain("upstream socket hangup");
    }
  });

  it("handles proxy.error events that have no exchange id (whole-proxy crash)", () => {
    const decoder = createDecoder();
    const out = decoder.decode({
      event: "proxy.error",
      t: "2026-05-12T00:00:00.000Z",
      message: "address already in use :::8402",
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.event).toBe("decoder.error");
    if (out[0]?.event === "decoder.error") {
      expect(out[0].id).toBeUndefined();
    }
  });
});
