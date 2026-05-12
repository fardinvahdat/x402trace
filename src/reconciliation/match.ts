/**
 * Pure match function: does this on-chain ChainTransfer correspond to
 * this pending PaymentExchange?
 *
 * Match key per ADR-001 + ARCHITECTURE.md § Reconciliation engine:
 *
 *   (payer, payee, value, nonce)  exact equality
 *
 * The EIP-3009 `nonce` is unique per (authorizer, contract) so a
 * (payer, payee, value, nonce) tuple is collision-safe — no fuzziness
 * needed. Addresses compared case-insensitively; bigints compared
 * structurally.
 *
 * Returns a small discriminated union so the engine can decide
 * whether to fire `settled_on_chain` / `value_mismatch` /
 * `recipient_mismatch` / no-op.
 */

import type { ChainTransfer } from "../chain/types.js";
import type { PendingExchange } from "./types.js";

export type MatchResult =
  | { readonly kind: "no_match" }
  | { readonly kind: "exact" }
  | { readonly kind: "value_mismatch"; readonly expected: bigint; readonly actual: bigint }
  | { readonly kind: "recipient_mismatch" };

export function matchPendingAgainstTransfer(
  pending: PendingExchange,
  transfer: ChainTransfer,
): MatchResult {
  const auth = pending.payment.payload.authorization;

  const sameNonce =
    typeof transfer.authorizationNonce === "string" &&
    transfer.authorizationNonce.toLowerCase() === auth.nonce.toLowerCase();
  const samePayer = auth.from.toLowerCase() === transfer.from.toLowerCase();

  // Nonce alone is collision-safe per (payer, contract). If both differ,
  // it's definitely not us. If only nonce matches but payer differs,
  // the chain client filtered to the wrong wallet or the chain emitted
  // a malformed event — either way, not our exchange.
  if (!sameNonce || !samePayer) return { kind: "no_match" };

  const expectedTo = auth.to.toLowerCase();
  const actualTo = transfer.to.toLowerCase();
  if (expectedTo !== actualTo) {
    return { kind: "recipient_mismatch" };
  }

  const expectedValue = BigInt(auth.value);
  if (expectedValue !== transfer.value) {
    return { kind: "value_mismatch", expected: expectedValue, actual: transfer.value };
  }

  return { kind: "exact" };
}
