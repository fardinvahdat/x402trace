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
  /** RPC URL. Default: `https://sepolia.base.org`. */
  readonly rpcUrl?: string;
  /** Per-RPC-call timeout in ms. Default 30_000 (matches the X402-12 ticket). */
  readonly rpcTimeoutMs?: number;
  /** Retry attempts on transient RPC failures. Default 3 per ARCHITECTURE.md. */
  readonly retries?: number;
  /**
   * Test escape hatch: inject a custom viem `Transport`. When set, `rpcUrl`
   * is ignored. Used by unit tests to mock RPC responses.
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

  /** Tear down any watchers. */
  close(): Promise<void>;
}
