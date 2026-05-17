/**
 * X402-12 chain client types.
 *
 * `ChainTransfer` matches the shape declared in ARCHITECTURE.md §
 * Key interfaces. `VerifyTransferResult` is the user-facing return
 * from `verifyTransfer({txHash, expected*})` per the X402-12 ticket —
 * 7 discriminated variants covering all four edge cases the ticket
 * names (tx not yet mined, tx reverted, wrong recipient/amount, tx
 * not found) plus the success case and two finer-grained mismatch
 * variants the reconciliation engine will want to distinguish.
 */

import type { Hex } from "viem";

export type Address = `0x${string}`;

/**
 * Supported chains. ADR-001 locked v0.1 to Base Sepolia; ADR-003 (v0.3)
 * extends to Base mainnet. No other chains in scope.
 *
 * Default in callers is `"base-sepolia"` — switching to mainnet is an
 * explicit, opt-in decision (CLI flag `--chain base` or env
 * `BASE_CHAIN_ID=8453`).
 */
export type ChainKey = "base-sepolia" | "base";

export interface ChainTransfer {
  readonly txHash: Hex;
  readonly blockNumber: bigint;
  readonly blockTimestamp: number; // unix seconds
  readonly from: Address;
  readonly to: Address;
  readonly value: bigint;
  readonly tokenAddress: Address;
  /** EIP-3009 `AuthorizationUsed.nonce` from the same tx, if present. */
  readonly authorizationNonce?: Hex;
}

export type VerifyTransferResult =
  | {
      readonly kind: "confirmed";
      readonly transfer: ChainTransfer;
      readonly confirmations: bigint;
    }
  | { readonly kind: "reverted"; readonly txHash: Hex }
  | { readonly kind: "pending"; readonly txHash: Hex }
  | { readonly kind: "not_found"; readonly txHash: Hex }
  | {
      readonly kind: "wrong_recipient";
      readonly transfer: ChainTransfer;
      readonly expectedTo: Address;
    }
  | {
      readonly kind: "wrong_amount";
      readonly transfer: ChainTransfer;
      readonly expectedAmount: bigint;
    }
  | {
      readonly kind: "wrong_token";
      readonly txHash: Hex;
      readonly expectedToken: Address;
      readonly actualToken: Address;
    };

export interface VerifyTransferOptions {
  readonly txHash: Hex;
  readonly expectedFrom?: Address;
  readonly expectedTo?: Address;
  readonly expectedAmount?: bigint;
  /** Defaults to Base Sepolia USDC. */
  readonly expectedToken?: Address;
}

export interface ChainClientOptions {
  /**
   * Which chain to read from. Default: `"base-sepolia"`.
   *
   * When `"base"`, an `rpcUrl` MUST be supplied — there is intentionally
   * no default mainnet RPC URL per CLAUDE.md hard rule #2 (no committed
   * mainnet URLs). The client throws on construction if `chain === "base"`
   * and no `rpcUrl` (or `transport` test escape) is provided.
   */
  readonly chain?: ChainKey;
  /**
   * RPC URL. Default for `chain: "base-sepolia"` is `https://sepolia.base.org`.
   * No default for `chain: "base"` — caller must supply.
   */
  readonly rpcUrl?: string;
  /** Per-RPC-call timeout in ms. Default 30_000 (matches the X402-12 ticket). */
  readonly rpcTimeoutMs?: number;
  /** Retry attempts on transient RPC failures. Default 3 per ARCHITECTURE.md. */
  readonly retries?: number;
  /**
   * Test escape hatch: inject a custom viem `Transport`. When set, `rpcUrl`
   * is ignored AND the no-default-mainnet-RPC guard is bypassed. Used by
   * unit tests to mock RPC responses on either chain.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly transport?: any;
}

export interface ChainClient {
  /** One-shot lookup. Returns null if tx not found or reverted. */
  getTransferByTxHash(hash: Hex): Promise<ChainTransfer | null>;

  /** Compare a tx hash against expected fields; classify into one of 7 variants. */
  verifyTransfer(opts: VerifyTransferOptions): Promise<VerifyTransferResult>;

  /**
   * Live USDC `Transfer` watcher. Polls for new blocks since `fromBlock`
   * (default: current block at subscribe time). Each emitted `ChainTransfer`
   * is enriched with the matching `AuthorizationUsed.nonce` if present.
   */
  subscribeUsdcTransfers(opts?: {
    fromBlock?: bigint;
    payer?: Address;
    pollIntervalMs?: number;
  }): AsyncIterable<ChainTransfer> & { unsubscribe(): void };

  /** Current head block number. Used to compute confirmations. */
  getBlockNumber(): Promise<bigint>;

  /**
   * X402-21 v0.2: read-only USDC balance for `validate`'s pre-flight
   * check. Returns the raw token amount (no decimals applied) so the
   * diagnose engine compares as bigints.
   */
  getUsdcBalance(wallet: Address): Promise<bigint>;

  /**
   * X402-21 v0.2: EIP-3009 nonce status. Returns true iff
   * `(authorizer, nonce)` has already been consumed on the USDC
   * contract. Used by the `nonce-fresh` diagnostic rule.
   */
  isNonceConsumed(authorizer: Address, nonce: Hex): Promise<boolean>;

  /**
   * X402-21 v0.2: best-effort wallet kind classification.
   * - `eoa` if the address has no contract code
   * - `smart-wallet` if it does
   * - `unknown` if the chain call errored
   *
   * v0.2 doesn't distinguish ERC-6492 (undeployed Smart Wallet) — that's
   * a v0.3 gap per ADR-002. A real ERC-6492 wallet that's never been
   * deployed shows up here as `eoa` (no code), which the diagnose
   * engine surfaces as a soft warning rather than a hard pass.
   */
  detectWalletKind(wallet: Address): Promise<"eoa" | "smart-wallet" | "unknown">;

  /** Tear down any watchers. */
  close(): Promise<void>;
}
