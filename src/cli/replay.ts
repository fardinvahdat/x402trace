/**
 * Offline JSONL replay. Reads a log written by `x402trace proxy
 * --reconcile`, reconstructs the four event streams the engine cares
 * about (proxy `exchange.closed`, decoder `exchange.payment`, chain
 * `chain.transfer`), and feeds them into a fresh engine.
 *
 * The engine runs on a *virtual clock* driven by each line's `t`
 * field so the `not_settled` sweep fires at the right virtual moment
 * even though the whole file replays in milliseconds.
 *
 * Per [ARCHITECTURE.md § JSONL record format](../../ARCHITECTURE.md#jsonl-record-format):
 * "the file IS the API." This reader is the consumer side of that
 * contract.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { ChainTransfer } from "../chain/types.js";
import type { DecodedEvent } from "../decoder/types.js";
import type { ProxyEvent } from "../proxy/types.js";
import type { ReconciliationEngine } from "../reconciliation/engine.js";
import { createReconciliationEngine } from "../reconciliation/engine.js";
import type { ReconciliationResult } from "../reconciliation/types.js";

export interface ReplayOptions {
  readonly logPath: string;
  readonly watchTimeoutMs?: number;
}

export interface ReplayCounts {
  readonly linesTotal: number;
  readonly linesSkipped: number;
  readonly proxyClosed: number;
  readonly decoderPayments: number;
  readonly chainTransfers: number;
  readonly results: number;
}

export interface ReplayReport {
  readonly counts: ReplayCounts;
  readonly results: readonly ReconciliationResult[];
}

/**
 * Replay the whole file, collect every emitted `ReconciliationResult`.
 *
 * Returns once the file is exhausted and the engine has been ticked
 * once past the final virtual timestamp so any still-pending entry
 * past `watchTimeoutMs` fires `not_settled`.
 */
export async function replayLog(opts: ReplayOptions): Promise<ReplayReport> {
  let virtualNow = 0;
  const engine = createReconciliationEngine({
    watchTimeoutMs: opts.watchTimeoutMs ?? 60_000,
    // setInterval clamps at int32 max (~24.8d); pick a value well
    // inside that window. Replay drives the sweep manually via `tick()`
    // so the timer should never actually fire during a replay run.
    sweepIntervalMs: 2_147_483_647,
    now: () => virtualNow,
  });

  const results: ReconciliationResult[] = [];
  const resultsSub = engine.results();
  const resultsTask = (async () => {
    for await (const r of resultsSub) results.push(r);
  })();

  let linesTotal = 0;
  let linesSkipped = 0;
  let proxyClosed = 0;
  let decoderPayments = 0;
  let chainTransfers = 0;

  const stream = createReadStream(opts.logPath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const rawLine of rl) {
    linesTotal++;
    const line = rawLine.trim();
    if (!line) {
      linesSkipped++;
      continue;
    }

    let record: { event?: unknown; t?: unknown };
    try {
      record = JSON.parse(line) as { event?: unknown; t?: unknown };
    } catch {
      linesSkipped++;
      continue;
    }

    if (typeof record.event !== "string" || typeof record.t !== "string") {
      linesSkipped++;
      continue;
    }

    const ts = Date.parse(record.t);
    if (Number.isFinite(ts)) {
      // Advance virtual time monotonically. If lines are out of order
      // we stay at the highest seen — never rewind.
      if (ts > virtualNow) virtualNow = ts;
      engine.tick();
    }

    switch (record.event) {
      case "exchange.closed": {
        engine.ingestProxyEvent(record as unknown as ProxyEvent);
        proxyClosed++;
        break;
      }
      case "exchange.payment": {
        engine.ingestDecoderEvent(record as unknown as DecodedEvent);
        decoderPayments++;
        break;
      }
      case "chain.transfer": {
        const transfer = reviveChainTransfer(record);
        if (transfer) {
          engine.ingestChainTransfer(transfer);
          chainTransfers++;
        } else {
          linesSkipped++;
        }
        break;
      }
      default: {
        // exchange.opened / exchange.challenge / exchange.settlement /
        // reconcile.result / proxy.error / decoder.error: not needed
        // for offline reconciliation (the engine joins on closed +
        // payment only). Don't count these as skipped errors.
        break;
      }
    }
  }

  // Drive the sweep one last time at the final timestamp + slack so
  // anything still pending past the watch window fires `not_settled`.
  virtualNow += (opts.watchTimeoutMs ?? 60_000) + 1;
  engine.tick();

  await engine.close();
  resultsSub.unsubscribe();
  await resultsTask;

  return {
    counts: {
      linesTotal,
      linesSkipped,
      proxyClosed,
      decoderPayments,
      chainTransfers,
      results: results.length,
    },
    results,
  };
}

/**
 * `chain.transfer` lines store `bigint` fields as strings (JSON has no
 * bigint). Resurrect them so the engine's match function sees real
 * `bigint`s.
 */
function reviveChainTransfer(record: Record<string, unknown>): ChainTransfer | null {
  const txHash = record.txHash;
  const from = record.from;
  const to = record.to;
  const tokenAddress = record.tokenAddress;
  if (
    typeof txHash !== "string" ||
    typeof from !== "string" ||
    typeof to !== "string" ||
    typeof tokenAddress !== "string"
  ) {
    return null;
  }
  const blockNumber = toBigint(record.blockNumber);
  const value = toBigint(record.value);
  if (blockNumber === null || value === null) return null;
  const blockTimestamp =
    typeof record.blockTimestamp === "number"
      ? record.blockTimestamp
      : Number(record.blockTimestamp);
  if (!Number.isFinite(blockTimestamp)) return null;
  const nonce =
    typeof record.authorizationNonce === "string"
      ? (record.authorizationNonce as `0x${string}`)
      : undefined;
  return {
    txHash: txHash as `0x${string}`,
    blockNumber,
    blockTimestamp,
    from: from as `0x${string}`,
    to: to as `0x${string}`,
    value,
    tokenAddress: tokenAddress as `0x${string}`,
    ...(nonce ? { authorizationNonce: nonce } : {}),
  };
}

function toBigint(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  return null;
}

/** Test seam: serialise a ChainTransfer to its JSONL-stored shape. */
export function chainTransferToJsonl(
  transfer: ChainTransfer,
  t: string = new Date().toISOString(),
): Record<string, unknown> {
  return {
    event: "chain.transfer",
    t,
    txHash: transfer.txHash,
    blockNumber: transfer.blockNumber.toString(),
    blockTimestamp: transfer.blockTimestamp,
    from: transfer.from,
    to: transfer.to,
    value: transfer.value.toString(),
    tokenAddress: transfer.tokenAddress,
    ...(transfer.authorizationNonce ? { authorizationNonce: transfer.authorizationNonce } : {}),
  };
}

// Re-export for callers that compose at the CLI layer.
export type { ReconciliationEngine };
