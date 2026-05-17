/**
 * X402-32 — `x402trace bazaar-check <service-url>` command.
 *
 * Pre-ship Bazaar / agentic.market implementation validator. Runs four
 * checks against the service URL and prints a single bottom-line
 * verdict that answers the operator's question: "is my implementation
 * correct, or is the bug upstream of me?"
 *
 * Read-only. No signing, no payment broadcast. The Jira-AC opt-in
 * paid-pass mode is deferred to v0.3.1 — see the X402-32 audit log.
 */

import { runBazaarCheck, type BazaarReport, type CheckResult } from "../bazaar/index.js";
import type { LogFormat } from "../decoder/types.js";
import { parseChainOrUndefined } from "./chain-flag.js";
import { createColorizer, type Colorizer } from "./color.js";
import { EXIT_USAGE, type ExitCode } from "./exit-codes.js";

export interface BazaarCheckCommandOptions {
  readonly service?: string;
  readonly log?: LogFormat;
  readonly chain?: "base-sepolia" | "base";
  /** Optional hint for the payer address (enables the self-payment guard's positive case). */
  readonly payerHint?: string;
  /** Override the CDP discovery base URL for tests / alternate facilitators. */
  readonly discoveryBaseUrl?: string;
}

export interface BazaarCheckRunContext {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly color?: Colorizer;
  /** Inject a custom fetcher (used by hermetic integration tests). */
  readonly fetcher?: typeof fetch;
}

export async function runBazaarCheckCommand(
  opts: BazaarCheckCommandOptions,
  ctx: BazaarCheckRunContext,
): Promise<ExitCode> {
  const service = opts.service;
  if (!service) {
    ctx.stderr.write("error: <service-url> argument is required\n");
    return EXIT_USAGE;
  }
  try {
    new URL(service);
  } catch {
    ctx.stderr.write(`error: <service-url> must be a valid URL (got '${service}')\n`);
    return EXIT_USAGE;
  }

  const chainKey: "base-sepolia" | "base" =
    opts.chain ?? parseChainOrUndefined(ctx.env.BASE_CHAIN_ID) ?? "base-sepolia";
  const format: LogFormat = opts.log ?? "human";
  const color = ctx.color ?? createColorizer({ stream: ctx.stdout as { isTTY?: boolean } });

  if (chainKey === "base") {
    const banner = color.paint(
      "yellow",
      "⚠ MAINNET (chain=base) — querying Base mainnet Bazaar discovery",
    );
    if (format === "human") ctx.stdout.write(`${banner}\n`);
    else ctx.stderr.write(`${banner}\n`);
  }

  const report = await runBazaarCheck({
    serviceUrl: service,
    chain: chainKey,
    ...(opts.payerHint !== undefined ? { payerHint: opts.payerHint } : {}),
    ...(opts.discoveryBaseUrl !== undefined ? { discoveryBaseUrl: opts.discoveryBaseUrl } : {}),
    ...(ctx.fetcher !== undefined ? { fetcher: ctx.fetcher } : {}),
  });

  if (format === "json") {
    ctx.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    ctx.stdout.write(`${formatReportHuman(report, color)}\n`);
  }

  return report.verdict.exitCode;
}

function formatReportHuman(report: BazaarReport, color: Colorizer): string {
  const lines: string[] = [];
  lines.push(color.paint("bold", `bazaar-check ${report.serviceUrl}`));
  lines.push(color.paint("dim", `  chain: ${report.chain}`));
  lines.push("");
  for (const r of report.results) {
    lines.push(formatCheckLine(r, color));
  }
  lines.push("");
  lines.push(formatVerdictLine(report, color));
  return lines.join("\n");
}

function formatCheckLine(r: CheckResult, color: Colorizer): string {
  const glyph =
    r.status === "pass"
      ? color.paint("green", "✓")
      : r.status === "fail"
        ? color.paint("red", "✗")
        : color.paint("yellow", "○");
  const label = color.paint("bold", padRight(r.check, 16));
  const fixLine = r.fix ? `\n    ${color.paint("dim", `fix: ${r.fix}`)}` : "";
  return `${glyph} ${label} ${r.message}${fixLine}`;
}

function formatVerdictLine(report: BazaarReport, color: Colorizer): string {
  const v = report.verdict;
  if (v.kind === "looks_correct") {
    return color.paint("green", `✓ VERDICT (exit 0): ${v.message}`);
  }
  if (v.kind === "implementation_issue") {
    return color.paint(
      "red",
      `✗ VERDICT (exit 2, implementation issue): ${v.message}\n  failed checks: ${v.failedChecks.join(", ")}`,
    );
  }
  return color.paint(
    "yellow",
    `○ VERDICT (exit 3, upstream issue): ${v.message}\n  upstream signals: ${v.upstreamChecks.join(", ")}`,
  );
}

function padRight(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
