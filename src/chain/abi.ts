/**
 * USDC + EIP-3009 event ABIs and well-known addresses for v0.1 (Base Sepolia only).
 *
 * Per ADR-001 the v0.1 wedge is Base-Sepolia-only with `exact` EVM scheme.
 * The USDC contract there (Circle's testnet FiatTokenV2) emits two events
 * we care about on a `transferWithAuthorization`:
 *
 *  1. `Transfer(from, to, value)` — ERC-20 standard event
 *  2. `AuthorizationUsed(authorizer, nonce)` — EIP-3009 settlement marker
 *
 * The reconciliation engine matches facilitator-timed-out payments to
 * on-chain settlements by `(payer, payee, value, nonce)` — the nonce is
 * what makes the match exact, since EIP-3009 nonces are unique per
 * (payer, contract).
 */

import type { Address } from "./types.js";

/** Base Sepolia USDC (Circle testnet FiatTokenV2). */
export const BASE_SEPOLIA_USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

export const USDC_TRANSFER_EVENT = {
  type: "event",
  name: "Transfer",
  inputs: [
    { indexed: true, name: "from", type: "address" },
    { indexed: true, name: "to", type: "address" },
    { indexed: false, name: "value", type: "uint256" },
  ],
} as const;

export const AUTHORIZATION_USED_EVENT = {
  type: "event",
  name: "AuthorizationUsed",
  inputs: [
    { indexed: true, name: "authorizer", type: "address" },
    { indexed: true, name: "nonce", type: "bytes32" },
  ],
} as const;
