/**
 * Streaming decoder. Consumes raw `ProxyEvent`s from the proxy and emits
 * structured `DecodedEvent`s. Pure-function-ish: holds no I/O state,
 * just a small in-memory map of partially-known exchanges so it can
 * correlate header data across the open/close pair.
 */
import type { ProxyEvent } from "../proxy/types.js";
import {
  detectVersion,
  findPaymentHeader,
  findSettlementHeader,
  parseChallengeBody,
  parsePaymentHeader,
  parseSettlementHeader,
} from "./parse.js";
import { redactPaymentPayload } from "./redact.js";
import type { DecodedEvent } from "./types.js";

export interface DecoderOptions {
  /** When false (default), signatures in payment payloads are replaced with "[REDACTED]". */
  readonly logSecrets?: boolean;
}

export interface Decoder {
  /**
   * Decode a single raw proxy event. Returns 0–N structured events.
   * Caller is responsible for sinking them (event bus, JSONL, stdout).
   */
  decode(event: ProxyEvent): DecodedEvent[];
}

export function createDecoder(opts: DecoderOptions = {}): Decoder {
  const logSecrets = opts.logSecrets ?? false;

  return {
    decode(event: ProxyEvent): DecodedEvent[] {
      const out: DecodedEvent[] = [];

      if (event.event === "exchange.opened") {
        // Look for a v1 X-PAYMENT or v2 PAYMENT-SIGNATURE in the request headers.
        const hit = findPaymentHeader(event.request.headers);
        if (hit) {
          const parsed = parsePaymentHeader(hit.value, hit.version);
          if (parsed.ok) {
            out.push({
              event: "exchange.payment",
              t: event.t,
              id: event.id,
              x402Version: hit.version,
              payment: redactPaymentPayload(parsed.value, logSecrets),
            });
          } else {
            out.push({
              event: "decoder.error",
              t: event.t,
              id: event.id,
              stage: "payment",
              message: parsed.message,
            });
          }
        }
        return out;
      }

      if (event.event === "exchange.closed") {
        // 402: parse the response body as a challenge.
        if (event.response.status === 402 && event.response.body !== undefined) {
          const parsed = parseChallengeBody(event.response.body);
          if (parsed.ok) {
            out.push({
              event: "exchange.challenge",
              t: event.t,
              id: event.id,
              x402Version: parsed.value.x402Version,
              challenge: parsed.value.requirements,
              ...(parsed.value.error ? { raw402Error: parsed.value.error } : {}),
            });
          } else {
            out.push({
              event: "decoder.error",
              t: event.t,
              id: event.id,
              stage: "challenge",
              message: parsed.message,
            });
          }
        }

        // Settlement: look for X-PAYMENT-RESPONSE / PAYMENT-RESPONSE header.
        const settlementHit = findSettlementHeader(event.response.headers);
        if (settlementHit) {
          const parsed = parseSettlementHeader(settlementHit.value);
          if (parsed.ok) {
            out.push({
              event: "exchange.settlement",
              t: event.t,
              id: event.id,
              settlement: parsed.value,
            });
          } else {
            out.push({
              event: "decoder.error",
              t: event.t,
              id: event.id,
              stage: "settlement",
              message: parsed.message,
            });
          }
        } else if (
          event.outcome.kind === "paid" &&
          "rawPaymentResponseHeader" in event.outcome &&
          event.outcome.rawPaymentResponseHeader
        ) {
          // Proxy already extracted the header; decode from there as a fallback.
          const parsed = parseSettlementHeader(event.outcome.rawPaymentResponseHeader);
          if (parsed.ok) {
            out.push({
              event: "exchange.settlement",
              t: event.t,
              id: event.id,
              settlement: parsed.value,
            });
          }
        }

        // Side note: the proxy already classified outcome via `event.outcome`
        // (paid | rejected | upstream_timeout | unknown). The decoder
        // doesn't re-emit it — downstream tools can read either signal.

        // Use detectVersion as a soft-validation hint; not directly emitted
        // but useful in future extensions.
        void detectVersion(event.response.headers);

        return out;
      }

      if (event.event === "proxy.error") {
        // Pass through as a decoder error; the proxy already wrote its
        // own proxy.error event to JSONL, so this is just for live
        // subscribers that only listen on the decoder bus.
        out.push({
          event: "decoder.error",
          t: event.t,
          ...(event.id ? { id: event.id } : {}),
          stage: "payment",
          message: `upstream/proxy error: ${event.message}`,
        });
        return out;
      }

      return out;
    },
  };
}
