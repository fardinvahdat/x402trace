/**
 * X402-11 decoder types.
 *
 * These shapes are the boundary between raw HTTP capture (proxy) and
 * structured downstream consumers (reconciliation, future inspect /
 * doctor tools). The JSON schema mirrors `src/decoder/schema.md` —
 * keep them in sync.
 */

/** Protocol surface. v0.1 is locked to v1 per ADR-001; v2 is detected
 *  but not deeply parsed. */
export type X402Version = 1 | 2;

export interface PaymentRequirements {
  readonly scheme: string;
  readonly network: string;
  readonly maxAmountRequired: string;
  readonly resource: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds?: number;
  readonly asset: string;
  readonly outputSchema?: unknown;
  readonly extra?: { readonly name?: string; readonly version?: string };
}

export interface PaymentAuthorization {
  readonly from: string;
  readonly to: string;
  readonly value: string;
  readonly validAfter: string;
  readonly validBefore: string;
  readonly nonce: string;
}

export interface PaymentPayload {
  readonly x402Version: X402Version;
  readonly scheme: string;
  readonly network: string;
  readonly payload: {
    /** Either the literal signature or "[REDACTED]" depending on logSecrets flag. */
    readonly signature: string;
    readonly authorization: PaymentAuthorization;
  };
}

export interface FacilitatorResponse {
  readonly success?: boolean;
  readonly isValid?: boolean;
  readonly invalidReason?: string;
  readonly errorReason?: string;
  readonly transaction?: string;
  readonly network?: string;
  readonly payer?: string;
}

/**
 * Discriminated union of events the decoder emits. Each corresponds to
 * a row in ARCHITECTURE.md § JSONL record format. `t` is ISO 8601; `id`
 * is the proxy's exchange id (so downstream tools can join).
 */
export type DecodedEvent =
  | {
      readonly event: "exchange.challenge";
      readonly t: string;
      readonly id: string;
      readonly x402Version: X402Version;
      readonly challenge: PaymentRequirements;
      readonly raw402Error?: string;
    }
  | {
      readonly event: "exchange.payment";
      readonly t: string;
      readonly id: string;
      readonly x402Version: X402Version;
      readonly payment: PaymentPayload;
    }
  | {
      readonly event: "exchange.settlement";
      readonly t: string;
      readonly id: string;
      readonly settlement: FacilitatorResponse;
    }
  | {
      readonly event: "decoder.error";
      readonly t: string;
      readonly id?: string;
      readonly stage: "challenge" | "payment" | "settlement";
      readonly message: string;
    };

/** Output format for the human/json logger. */
export type LogFormat = "human" | "json";
