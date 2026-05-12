/**
 * `x402trace explain <jsonl-log-file>` — offline plain-English
 * diagnosis (X402-21 v0.2 per [ADR-002](../../DECISIONS.md#adr-002-v02-feature-pick--validate-primary--explain-paired)).
 *
 * Pure-offline: never opens an HTTP server, never makes an RPC call.
 * Reads the JSONL log a `proxy --reconcile` run produced, walks it
 * once to build a per-exchange index, then renders a diagnose report
 * for every exchange whose reconcile outcome wasn't `settled_on_chain`
 * plus every standalone `decoder.error` event.
 *
 * Distinct from `inspect` (X402-14):
 *   - `inspect` re-runs the reconciliation match logic; output is
 *     reconcile-engine-shaped (`settled_on_chain` / `not_settled` / …).
 *   - `explain` re-runs the diagnose rule engine; output is
 *     per-failure prose with actionable fixes.
 *
 * The two are complementary — `inspect` says "the match logic still
 * says 12 of your 50 exchanges failed reconciliation"; `explain` says
 * "the recipient address on exchange `94c15089` doesn't match the
 * challenge's payTo, fix with …".
 */

import { readFile, stat } from "node:fs/promises";
import type { LogFormat, PaymentPayload, PaymentRequirements } from "../decoder/types.js";
import { diagnose, formatReportHuman, formatReportJson } from "../diagnose/index.js";
import type { DiagnosticContext } from "../diagnose/types.js";
import { createColorizer, type Colorizer } from "./color.js";
import { EXIT_RUNTIME, EXIT_SUCCESS, EXIT_USAGE, type ExitCode } from "./exit-codes.js";

export interface ExplainCommandOptions {
  readonly logFile?: string;
  readonly log?: LogFormat;
}

export interface ExplainRunContext {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly color?: Colorizer;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}

export async function runExplainCommand(
  opts: ExplainCommandOptions,
  ctx: ExplainRunContext,
): Promise<ExitCode> {
  const logFile = opts.logFile;
  if (!logFile) {
    ctx.stderr.write("error: <jsonl-log-file> argument is required\n");
    return EXIT_USAGE;
  }
  try {
    const s = await stat(logFile);
    if (!s.isFile()) {
      ctx.stderr.write(`error: ${logFile} is not a file\n`);
      return EXIT_USAGE;
    }
  } catch {
    ctx.stderr.write(`error: cannot read ${logFile}\n`);
    return EXIT_USAGE;
  }

  const format: LogFormat = opts.log ?? "human";
  const color = ctx.color ?? createColorizer({ stream: ctx.stdout as { isTTY?: boolean } });
  const now = (ctx.now ?? (() => new Date()))();

  // ─── Walk the log once, indexing by exchange id ────────────────
  // For each exchange we need the challenge (requirements), the
  // payment (authorization), and the reconcile.result if any. We
  // *don't* need walletState — the log doesn't capture it.
  const challenges = new Map<string, PaymentRequirements>();
  const payments = new Map<string, PaymentPayload>();
  const reconcileResults = new Map<string, { kind: string; ts: string }>();
  const decoderErrors: Array<{ ts: string; id?: string; stage: string; message: string }> = [];

  const raw = await readFile(logFile, "utf8");
  let lineNum = 0;
  for (const line of raw.split("\n")) {
    lineNum += 1;
    if (!line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      // Bad line — skip silently. `inspect` already covers this surface
      // (it logs counts.linesSkipped); duplicate the count handling here.
      continue;
    }
    if (!rec || typeof rec !== "object") continue;
    const r = rec as Record<string, unknown>;
    const event = typeof r.event === "string" ? r.event : null;
    const id = typeof r.id === "string" ? r.id : null;

    if (event === "exchange.challenge" && id && typeof r.challenge === "object") {
      challenges.set(id, r.challenge as PaymentRequirements);
    } else if (event === "exchange.payment" && id && typeof r.payment === "object") {
      payments.set(id, r.payment as PaymentPayload);
    } else if (event === "reconcile.result" && typeof r.exchangeId === "string") {
      reconcileResults.set(r.exchangeId, {
        kind: typeof r.kind === "string" ? r.kind : "unknown",
        ts: typeof r.t === "string" ? r.t : "",
      });
    } else if (event === "decoder.error") {
      decoderErrors.push({
        ts: typeof r.t === "string" ? r.t : "",
        ...(id ? { id } : {}),
        stage: typeof r.stage === "string" ? r.stage : "unknown",
        message: typeof r.message === "string" ? r.message : "",
      });
    }
  }

  // ─── Filter: which exchanges deserve an "explain" block? ───────
  // - Any reconcile.result whose kind != settled_on_chain → that exchange failed.
  // - Any decoder.error → render its message + the exchange context (if id available).
  const explainableExchangeIds = new Set<string>();
  for (const [id, result] of reconcileResults) {
    if (result.kind !== "settled_on_chain") explainableExchangeIds.add(id);
  }

  // ─── Render ────────────────────────────────────────────────────
  const counts = {
    linesTotal: lineNum,
    explained: 0,
    decoderErrors: decoderErrors.length,
  };

  if (format === "human") {
    ctx.stdout.write(
      `${color.paint("bold", `explain ${logFile}`)}  ${color.paint("dim", `(${challenges.size} exchanges captured, ${reconcileResults.size} reconciled)`)}\n\n`,
    );
  }

  for (const id of explainableExchangeIds) {
    const requirements = challenges.get(id);
    const payment = payments.get(id);
    const result = reconcileResults.get(id);
    if (!requirements) {
      // Can't diagnose without a challenge to compare against.
      if (format === "human") {
        ctx.stdout.write(
          `${color.paint("yellow", "⚠")} exchange ${color.paint("bold", id.slice(0, 8))}…: reconcile said ${result?.kind} but no challenge in log — skipping\n`,
        );
      }
      continue;
    }
    const diagCtx: DiagnosticContext = {
      requirements,
      ...(payment ? { payment } : {}),
      now,
    };
    const report = diagnose(diagCtx);
    counts.explained += 1;

    if (format === "human") {
      ctx.stdout.write(
        `${color.paint("bold", `─── exchange ${id.slice(0, 8)}… ${result?.kind} at ${result?.ts} ───`)}\n`,
      );
      ctx.stdout.write(`${formatReportHuman(report, color)}\n\n`);
    } else {
      ctx.stdout.write(
        `${JSON.stringify({ event: "explain.exchange", exchangeId: id, reconcileKind: result?.kind, ts: result?.ts })}\n`,
      );
      ctx.stdout.write(`${formatReportJson(report)}\n`);
    }
  }

  // Standalone decoder errors (no diagnose run — just surface them).
  for (const err of decoderErrors) {
    if (format === "human") {
      const idLabel = err.id ? `${err.id.slice(0, 8)}…` : "(no id)";
      ctx.stdout.write(
        `${color.paint("red", "✗")} decoder.error ${color.paint("bold", idLabel)} stage=${err.stage}: ${err.message}\n`,
      );
    } else {
      ctx.stdout.write(`${JSON.stringify({ event: "explain.decoder-error", ...err })}\n`);
    }
  }

  // Trailer counts so downstream tools can sanity-check.
  if (format === "human") {
    ctx.stdout.write(
      `\n${color.paint("dim", `explained ${counts.explained} failed exchange(s), ${counts.decoderErrors} decoder error(s) from ${counts.linesTotal} lines`)}\n`,
    );
  } else {
    ctx.stdout.write(`${JSON.stringify({ event: "explain.summary", ...counts })}\n`);
  }

  // Exit code: 2 if any exchange or decoder error was rendered; 0 if
  // the log was clean. This makes `explain` usable in CI to gate
  // "no reconciliation failures since last deploy".
  if (counts.explained > 0 || counts.decoderErrors > 0) return EXIT_RUNTIME;
  return EXIT_SUCCESS;
}
