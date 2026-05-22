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

const MAX_NODE_TIMEOUT_MS = 2_147_483_647;

export interface BazaarCheckCommandOptions {
  readonly service?: string;
  readonly log?: LogFormat;
  readonly chain?: "base-sepolia" | "base";
  /** Optional hint for the payer address (enables the self-payment guard's positive case). */
  readonly payerHint?: string;
  /** Override the CDP discovery base URL for tests / alternate facilitators. */
  readonly discoveryBaseUrl?: string;
  /** Per-request timeout for bazaar-check HTTP probes. */
  readonly timeoutMs?: number;
  /**
   * X402-42 (D.4) — per-route 402 probe mode. When set, skips the root
   * `/.well-known/x402` probe and fetches the 402 challenge directly
   * from this paid endpoint URL instead. For services that only
   * publish per-route (TensorFeed shape) or for validating one
   * specific paid resource.
   */
  readonly endpoint?: string;
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
  if (opts.endpoint !== undefined) {
    try {
      new URL(opts.endpoint);
    } catch {
      ctx.stderr.write(`error: --endpoint must be a valid URL (got '${opts.endpoint}')\n`);
      return EXIT_USAGE;
    }
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

  const timeoutMs = opts.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    ctx.stderr.write(
      `error: --timeout-ms must be a positive number (got '${String(opts.timeoutMs)}')\n`,
    );
    return EXIT_USAGE;
  }
  if (timeoutMs > MAX_NODE_TIMEOUT_MS) {
    ctx.stderr.write(
      `error: --timeout-ms must be <= ${MAX_NODE_TIMEOUT_MS} (got '${String(opts.timeoutMs)}')\n`,
    );
    return EXIT_USAGE;
  }

  const fetcher = withRequestTimeout(ctx.fetcher ?? fetch, timeoutMs);

  // X402-42 (D.4) — per-route probe mode UX note.
  if (opts.endpoint !== undefined) {
    const note =
      "ℹ skipping root /.well-known/x402 probe per --endpoint. " +
      "Note: services that DO publish at root signal extra discoverability hygiene; consider both.";
    if (format === "human") ctx.stdout.write(`${note}\n`);
    else ctx.stderr.write(`${note}\n`);
  }

  const report = await runBazaarCheck({
    serviceUrl: service,
    chain: chainKey,
    ...(opts.payerHint !== undefined ? { payerHint: opts.payerHint } : {}),
    ...(opts.discoveryBaseUrl !== undefined ? { discoveryBaseUrl: opts.discoveryBaseUrl } : {}),
    ...(opts.endpoint !== undefined ? { endpoint: opts.endpoint } : {}),
    fetcher,
  });

  if (format === "json") {
    ctx.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    ctx.stdout.write(`${formatReportHuman(report, color)}\n`);
  }

  return report.verdict.exitCode;
}

function withRequestTimeout(fetcher: typeof fetch, timeoutMs: number): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(input, { ...init, signal: controller.signal });
      return withBodyTimeoutCleanup(response, timer);
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }) as typeof fetch;
}

function withBodyTimeoutCleanup(response: Response, timer: NodeJS.Timeout): Response {
  const clear = (): void => clearTimeout(timer);
  const wrapBodyReader = <TArgs extends unknown[], TResult>(
    read: (...args: TArgs) => Promise<TResult>,
  ): ((...args: TArgs) => Promise<TResult>) => {
    return async (...args: TArgs): Promise<TResult> => {
      try {
        return await read(...args);
      } finally {
        clear();
      }
    };
  };

  Object.defineProperty(response, "arrayBuffer", {
    value: wrapBodyReader(response.arrayBuffer.bind(response)),
  });
  Object.defineProperty(response, "blob", { value: wrapBodyReader(response.blob.bind(response)) });
  Object.defineProperty(response, "formData", {
    value: wrapBodyReader(response.formData.bind(response)),
  });
  Object.defineProperty(response, "json", { value: wrapBodyReader(response.json.bind(response)) });
  Object.defineProperty(response, "text", { value: wrapBodyReader(response.text.bind(response)) });
  if (response.body === null) clear();
  return response;
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
