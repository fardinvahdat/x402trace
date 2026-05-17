/**
 * USDC + EIP-3009 event ABIs and well-known addresses.
 *
 * Per ADR-001 the v0.1 wedge was Base-Sepolia-only with `exact` EVM
 * scheme. ADR-003 (v0.3) extends to Base mainnet via the `chain` option
 * on `createChainClient`; the scheme constraint (exact EVM) stays.
 *
 * The USDC contracts on both chains emit two events we care about on a
 * `transferWithAuthorization`:
 *
 *  1. `Transfer(from, to, value)` — ERC-20 standard event
 *  2. `AuthorizationUsed(authorizer, nonce)` — EIP-3009 settlement marker
 *
 * The reconciliation engine matches facilitator-timed-out payments to
 * on-chain settlements by `(payer, payee, value, nonce)` — the nonce is
 * what makes the match exact, since EIP-3009 nonces are unique per
 * (payer, contract).
 */

import type { Address, ChainKey } from "./types.js";

/** Base Sepolia USDC (Circle testnet FiatTokenV2). Chain ID 84532. */
export const BASE_SEPOLIA_USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/** Base mainnet USDC (Circle FiatTokenV2). Chain ID 8453. */
export const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/**
 * Resolve the canonical USDC contract for a given chain key. The
 * reconciliation engine and `validate` / `bazaar-check` callers go
 * through this so chain ↔ asset mapping is single-source.
 */
export function usdcAddressFor(chain: ChainKey): Address {
  return chain === "base" ? BASE_USDC : BASE_SEPOLIA_USDC;
}

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

/**
 * Read-only USDC functions used by `validate` (X402-21). `balanceOf`
 * and EIP-3009's `authorizationState` give us pre-flight visibility
 * without signing anything. Kept narrow — we only declare the
 * functions we actually call, so importing this ABI subset doesn't
 * advertise capabilities x402trace doesn't use.
 */
export const USDC_READ_ABI = [
  {
    type: "function",
    stateMutability: "view",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    // EIP-3009: returns true iff the nonce was already consumed for
    // this authorizer. `transferWithAuthorization` flips this from
    // false to true atomically with the Transfer.
    type: "function",
    stateMutability: "view",
    name: "authorizationState",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;
