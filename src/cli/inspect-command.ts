/**
 * `x402trace inspect <jsonl-log-file>` — replay a saved JSONL log,
 * re-run the reconciliation engine against it, print every result.
 *
 * Pure-offline: never opens an HTTP server, never makes an RPC call.
 * Reads the existing `chain.transfer` lines the live `proxy --reconcile`
 * already persisted, joins them against `exchange.closed` /
 * `exchange.payment`, emits `ReconciliationResult`s through the same
 * formatter the live command uses.
 *
 * Useful for: re-running reconciliation after tweaking match logic;
 * diagnosing a past outage from its captured log; CI smoke tests that
 * don't want to spin up a real proxy.
 */

import { stat } from "node:fs/promises";
import type { LogFormat } from "../decoder/types.js";
import { createColorizer, type Colorizer } from "./color.js";
import { EXIT_RUNTIME, EXIT_SUCCESS, EXIT_USAGE, type ExitCode } from "./exit-codes.js";
import { formatResultHuman, formatResultJson } from "./format-result.js";
import { replayLog } from "./replay.js";

export interface InspectCommandOptions {
  readonly logFile?: string;
  readonly log?: LogFormat;
  readonly watchTimeoutMs?: number;
  /**
   * Chain context for the replay. Informational only — `inspect` is
   * pure offline and never makes RPC calls — but accepting the flag
   * keeps the surface consistent across subcommands and lets the
   * operator's intent be visible in the output banner.
   */
  readonly chain?: "base-sepolia" | "base";
}

export interface InspectRunContext {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly color?: Colorizer;
}

const DEFAULT_WATCH_TIMEOUT_MS = 60_000;

export async function runInspectCommand(
  opts: InspectCommandOptions,
  ctx: InspectRunContext,
): Promise<ExitCode> {
  const logFile = opts.logFile;
  if (!logFile) {
    ctx.stderr.write("error: <jsonl-log-file> argument is required\n");
    return EXIT_USAGE;
  }

  try {
    const s = await stat(logFile);
    if (!s.isFile()) {
      ctx.stderr.write(`error: ${logFile} is not a regular file\n`);
      return EXIT_USAGE;
    }
  } catch {
    ctx.stderr.write(`error: cannot read log file: ${logFile}\n`);
    return EXIT_USAGE;
  }

  const format: LogFormat = opts.log ?? "human";
  const color = ctx.color ?? createColorizer({ stream: ctx.stdout as { isTTY?: boolean } });

  if (opts.chain === "base") {
    const banner = color.paint(
      "yellow",
      "⚠ MAINNET (chain=base) — replaying a mainnet capture; inspect itself is pure offline",
    );
    if (format === "human") ctx.stdout.write(`${banner}\n`);
    else ctx.stderr.write(`${banner}\n`);
  }

  try {
    const report = await replayLog({
      logPath: logFile,
      watchTimeoutMs: opts.watchTimeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS,
    });

    if (format === "human") {
      ctx.stdout.write(
        color.paint(
          "dim",
          `replayed ${report.counts.linesTotal} lines (skipped=${report.counts.linesSkipped}, closed=${report.counts.proxyClosed}, payments=${report.counts.decoderPayments}, transfers=${report.counts.chainTransfers}, results=${report.counts.results})`,
        ) + "\n",
      );
    }

    for (const result of report.results) {
      ctx.stdout.write(
        format === "human"
          ? `${formatResultHuman(result, color)}\n`
          : `${formatResultJson(result)}\n`,
      );
    }

    if (format === "json") {
      // Trailer record with replay counts so JSON consumers can sanity-check.
      ctx.stdout.write(`${JSON.stringify({ event: "inspect.summary", ...report.counts })}\n`);
    }

    return EXIT_SUCCESS;
  } catch (err) {
    ctx.stderr.write(
      `${color.paint("red", "inspect failed:")} ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return EXIT_RUNTIME;
  }
}
