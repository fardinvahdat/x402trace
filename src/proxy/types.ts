/**
 * X402-10 proxy core types.
 *
 * The proxy is deliberately dumb: it captures raw HTTP and emits typed
 * events. No x402 protocol parsing happens here — that's the decoder's
 * job (X402-11). These shapes are the JSONL-on-disk format per
 * ARCHITECTURE.md § JSONL record format; downstream readers depend on
 * them being stable.
 */

/** Stable identifier for a single client request / upstream response pair. */
export type ExchangeId = string;

export interface CapturedRequest {
  /** HTTP method, uppercase. */
  readonly method: string;
  /** Path + query the client asked for (e.g. `/api/weather?x=1`). */
  readonly path: string;
  /** Lowercase header name → value. Multi-value headers are joined with `, `. */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Request body. Empty string when no body or GET/HEAD.
   * If non-UTF8 or binary, `bodyBase64` is set instead.
   */
  readonly body?: string;
  readonly bodyBase64?: string;
}

export interface CapturedResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly bodyBase64?: string;
}

/**
 * Classification of what happened to a proxied exchange. Kept coarse so
 * the proxy never has to understand x402 protocol semantics — the
 * discriminant is determined from HTTP status + presence of payment
 * headers only.
 */
export type ExchangeOutcome =
  | {
      readonly kind: "paid";
      readonly status: number; // typically 200
      readonly receivedAt: string;
      /** Raw value of X-PAYMENT-RESPONSE if upstream returned one. Decoder parses. */
      readonly rawPaymentResponseHeader?: string;
    }
  | {
      readonly kind: "rejected";
      readonly status: number; // typically 402
      readonly receivedAt: string;
      /** Raw response body (text). Decoder extracts errorReason if x402-shaped. */
      readonly rawBody?: string;
    }
  | {
      readonly kind: "upstream_timeout";
      readonly afterMs: number;
      readonly observedAt: string;
    }
  | {
      readonly kind: "unknown";
      readonly status: number;
      readonly receivedAt: string;
    };

/**
 * Discriminated union of every event the proxy emits.
 * `t` is ISO 8601, `event` is the discriminant.
 */
export type ProxyEvent =
  | {
      readonly event: "exchange.opened";
      readonly t: string;
      readonly id: ExchangeId;
      readonly upstreamUrl: string;
      readonly request: CapturedRequest;
    }
  | {
      readonly event: "exchange.closed";
      readonly t: string;
      readonly id: ExchangeId;
      readonly response: CapturedResponse;
      readonly outcome: ExchangeOutcome;
      readonly durationMs: number;
    }
  | {
      readonly event: "proxy.error";
      readonly t: string;
      readonly id?: ExchangeId;
      readonly message: string;
      readonly stack?: string;
    };

/**
 * Heuristic: is this request/response pair x402-related at all?
 *
 * v0.1 detection rule (pure HTTP signals, no x402 parsing):
 * - Request has an `X-PAYMENT` or `PAYMENT-SIGNATURE` header, OR
 * - Response has a `402` status, OR
 * - Response has an `X-PAYMENT-RESPONSE` or `PAYMENT-RESPONSE` header.
 *
 * The proxy logs every request/response regardless; this heuristic is
 * used downstream by the decoder/reconciler to skip non-x402 traffic
 * cheaply.
 */
export function isLikelyX402Exchange(
  req: CapturedRequest,
  res: CapturedResponse | undefined,
): boolean {
  if (req.headers["x-payment"] || req.headers["payment-signature"]) return true;
  if (!res) return false;
  if (res.status === 402) return true;
  if (res.headers["x-payment-response"] || res.headers["payment-response"]) return true;
  return false;
}
