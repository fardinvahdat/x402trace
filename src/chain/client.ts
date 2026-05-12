import { createPublicClient, decodeEventLog, http, type Hex, type Log, type Transport } from "viem";
import { baseSepolia } from "viem/chains";
import { AUTHORIZATION_USED_EVENT, BASE_SEPOLIA_USDC, USDC_TRANSFER_EVENT } from "./abi.js";
import { withRetry } from "./retry.js";
import type {
  Address,
  ChainClient,
  ChainClientOptions,
  ChainTransfer,
  VerifyTransferOptions,
  VerifyTransferResult,
} from "./types.js";

const DEFAULT_RPC_URL = "https://sepolia.base.org";
const DEFAULT_POLL_INTERVAL_MS = 4_000;

function isNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name;
  if (
    name === "TransactionReceiptNotFoundError" ||
    name === "TransactionNotFoundError" ||
    name === "BlockNotFoundError"
  ) {
    return true;
  }
  return /not\s+(be\s+)?found/i.test(err.message);
}

/**
 * Build a read-only chain client for Base Sepolia. Never holds private
 * keys; never broadcasts transactions. Only reads logs + receipts.
 */
export function createChainClient(opts: ChainClientOptions = {}): ChainClient {
  const transport: Transport =
    (opts.transport as Transport | undefined) ??
    http(opts.rpcUrl ?? DEFAULT_RPC_URL, { timeout: opts.rpcTimeoutMs ?? 30_000 });
  const client = createPublicClient({ chain: baseSepolia, transport });
  const retries = opts.retries ?? 3;

  const subscribers = new Set<{ stop: () => void }>();

  async function getBlockNumber(): Promise<bigint> {
    return withRetry(() => client.getBlockNumber(), { retries });
  }

  function findTransferLog(logs: readonly Log[], expectedToken?: Address) {
    const tokenFilter = (expectedToken ?? BASE_SEPOLIA_USDC).toLowerCase();
    for (const log of logs) {
      if (log.address.toLowerCase() !== tokenFilter) continue;
      try {
        const decoded = decodeEventLog({
          abi: [USDC_TRANSFER_EVENT],
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === "Transfer") {
          const args = decoded.args as { from: Address; to: Address; value: bigint };
          return { log, ...args };
        }
      } catch {
        // not a Transfer log on this contract; skip
      }
    }
    return null;
  }

  function findAuthorizationNonce(logs: readonly Log[], expectedToken?: Address): Hex | undefined {
    const tokenFilter = (expectedToken ?? BASE_SEPOLIA_USDC).toLowerCase();
    for (const log of logs) {
      if (log.address.toLowerCase() !== tokenFilter) continue;
      try {
        const decoded = decodeEventLog({
          abi: [AUTHORIZATION_USED_EVENT],
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === "AuthorizationUsed") {
          return (decoded.args as { nonce: Hex }).nonce;
        }
      } catch {
        // not AuthorizationUsed; skip
      }
    }
    return undefined;
  }

  async function buildTransferFromReceipt(
    txHash: Hex,
    expectedToken?: Address,
  ): Promise<ChainTransfer | { mismatch: { actualToken: Address } } | null> {
    let receipt;
    try {
      receipt = await withRetry(() => client.getTransactionReceipt({ hash: txHash }), { retries });
    } catch (err) {
      // viem throws TransactionReceiptNotFoundError when the receipt
      // isn't available yet (tx pending OR doesn't exist).
      if (isNotFoundError(err)) return null;
      throw err;
    }
    if (receipt.status !== "success") return null;

    const found = findTransferLog(receipt.logs, expectedToken);
    if (!found) {
      // No Transfer log on the expected token. If there are Transfer logs
      // for a different token, surface that as a mismatch hint.
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({
            abi: [USDC_TRANSFER_EVENT],
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === "Transfer") {
            return { mismatch: { actualToken: log.address } };
          }
        } catch {
          // skip
        }
      }
      return null;
    }
    const nonce = findAuthorizationNonce(receipt.logs, expectedToken);
    const block = await withRetry(() => client.getBlock({ blockHash: receipt.blockHash }), {
      retries,
    });
    return {
      txHash,
      blockNumber: receipt.blockNumber,
      blockTimestamp: Number(block.timestamp),
      from: found.from,
      to: found.to,
      value: found.value,
      tokenAddress: (expectedToken ?? BASE_SEPOLIA_USDC) as Address,
      ...(nonce ? { authorizationNonce: nonce } : {}),
    };
  }

  async function getTransferByTxHash(hash: Hex): Promise<ChainTransfer | null> {
    const result = await buildTransferFromReceipt(hash);
    if (!result) return null;
    if ("mismatch" in result) return null;
    return result;
  }

  async function verifyTransfer(opts: VerifyTransferOptions): Promise<VerifyTransferResult> {
    const expectedToken = (opts.expectedToken ?? BASE_SEPOLIA_USDC) as Address;
    // buildTransferFromReceipt returns null for not-found / non-success
    // receipts; only rethrows on unrecoverable RPC errors, which we let
    // bubble up to the caller.
    const result = await buildTransferFromReceipt(opts.txHash, expectedToken);

    if (result && "mismatch" in result) {
      return {
        kind: "wrong_token",
        txHash: opts.txHash,
        expectedToken,
        actualToken: result.mismatch.actualToken,
      };
    }

    if (!result) {
      // Distinguish pending from not_found vs reverted by inspecting the tx
      // itself.
      let tx;
      try {
        tx = await withRetry(() => client.getTransaction({ hash: opts.txHash }), { retries });
      } catch (err) {
        if (isNotFoundError(err)) {
          return { kind: "not_found", txHash: opts.txHash };
        }
        throw err;
      }
      if (!tx) return { kind: "not_found", txHash: opts.txHash };
      if (tx.blockNumber === null) return { kind: "pending", txHash: opts.txHash };
      // Has a block but receipt was null → must be reverted.
      return { kind: "reverted", txHash: opts.txHash };
    }

    const transfer = result;

    if (opts.expectedTo && transfer.to.toLowerCase() !== opts.expectedTo.toLowerCase()) {
      return { kind: "wrong_recipient", transfer, expectedTo: opts.expectedTo };
    }
    if (opts.expectedAmount !== undefined && transfer.value !== opts.expectedAmount) {
      return { kind: "wrong_amount", transfer, expectedAmount: opts.expectedAmount };
    }
    if (opts.expectedFrom && transfer.from.toLowerCase() !== opts.expectedFrom.toLowerCase()) {
      // Treat "wrong from" as a recipient-class mismatch with a different
      // surface; future variant could split this. v0.1: bundle into
      // wrong_recipient with the offending address — but expectedTo is
      // semantically about the receiver. To keep the discriminant clean,
      // we surface from-mismatches as wrong_recipient with the expected
      // *to* echoed, since reconciliation cares about all four fields
      // together. The downstream engine checks transfer.from separately.
      return { kind: "wrong_recipient", transfer, expectedTo: opts.expectedTo ?? transfer.to };
    }

    const head = await getBlockNumber();
    const confirmations = head >= transfer.blockNumber ? head - transfer.blockNumber + 1n : 0n;
    return { kind: "confirmed", transfer, confirmations };
  }

  function subscribeUsdcTransfers(
    subOpts: { fromBlock?: bigint; payer?: Address; pollIntervalMs?: number } = {},
  ) {
    const pollMs = subOpts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const queue: ChainTransfer[] = [];
    const resolvers: Array<(v: IteratorResult<ChainTransfer>) => void> = [];
    let done = false;
    let cursor: bigint | null = null;
    let stopFn: (() => void) | null = null;

    const pumpQueue = (): void => {
      while (queue.length > 0 && resolvers.length > 0) {
        const next = queue.shift()!;
        const resolve = resolvers.shift()!;
        resolve({ value: next, done: false });
      }
    };

    const finish = (): void => {
      done = true;
      while (resolvers.length > 0) {
        resolvers.shift()!({ value: undefined as never, done: true });
      }
      if (stopFn) {
        const s = stopFn;
        stopFn = null;
        s();
      }
    };

    const poll = async (): Promise<void> => {
      try {
        const head = await getBlockNumber();
        if (cursor === null) {
          cursor = subOpts.fromBlock ?? head;
        }
        if (head <= cursor) return;

        const fromBlock = cursor + 1n;
        const toBlock = head;
        const logs = await withRetry(
          () =>
            client.getLogs({
              address: BASE_SEPOLIA_USDC,
              event: USDC_TRANSFER_EVENT,
              fromBlock,
              toBlock,
              ...(subOpts.payer ? { args: { from: subOpts.payer } } : {}),
            }),
          { retries },
        );

        // For each Transfer, fetch the receipt to enrich with the AuthorizationUsed nonce.
        for (const log of logs) {
          if (!log.transactionHash) continue;
          const enriched = await buildTransferFromReceipt(log.transactionHash);
          if (!enriched || "mismatch" in enriched) continue;
          queue.push(enriched);
        }

        cursor = head;
        pumpQueue();
      } catch {
        // Per ARCHITECTURE.md: "mark the watch as degraded — the proxy
        // keeps logging regardless." We swallow + retry next tick. Future
        // versions can surface a "subscription.degraded" event.
      }
    };

    const interval = setInterval(() => void poll(), pollMs);
    // Kick off the first poll immediately so callers don't wait pollMs.
    void poll();
    stopFn = () => clearInterval(interval);

    const handle: AsyncIterable<ChainTransfer> & { unsubscribe(): void } = {
      [Symbol.asyncIterator]: () => ({
        next(): Promise<IteratorResult<ChainTransfer>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (done) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise<IteratorResult<ChainTransfer>>((res) => resolvers.push(res));
        },
        return(): Promise<IteratorResult<ChainTransfer>> {
          finish();
          return Promise.resolve({ value: undefined as never, done: true });
        },
      }),
      unsubscribe: finish,
    };
    subscribers.add({ stop: finish });
    return handle;
  }

  async function close(): Promise<void> {
    for (const s of subscribers) s.stop();
    subscribers.clear();
  }

  return {
    getTransferByTxHash,
    verifyTransfer,
    subscribeUsdcTransfers,
    getBlockNumber,
    close,
  };
}
