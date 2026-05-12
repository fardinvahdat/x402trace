import type { PaymentPayload } from "./types.js";

const REDACTED = "[REDACTED]";

/**
 * Redact the EIP-3009 signature from a payment payload.
 *
 * Per the X402-11 ticket: "Redact private keys / signatures by default;
 * expose with --log-secrets flag." The signature itself is not strictly
 * a secret (it's broadcast on-chain in the eventual settlement tx), but
 * v0.1 redacts it by default to avoid surprising users who pipe their
 * JSONL into pastebins / share with teammates. Operators who want the
 * full signature flip the flag explicitly.
 */
export function redactPaymentPayload(payment: PaymentPayload, logSecrets: boolean): PaymentPayload {
  if (logSecrets) return payment;
  return {
    ...payment,
    payload: {
      ...payment.payload,
      signature: REDACTED,
    },
  };
}
