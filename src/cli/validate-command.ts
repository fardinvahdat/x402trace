/**
 * `x402trace validate <wallet> <service-url>` — pre-flight check
 * (X402-21 v0.2, per [ADR-002](../../DECISIONS.md#adr-002-v02-feature-pick--validate-primary--explain-paired)).
 *
 * Reads a service's 402 challenge, queries the wallet's on-chain state,
 * builds a `DiagnosticContext`, and runs the `diagnose()` engine. No
 * signing, no broadcasting — wallet provided is just the address.
 *
 * Exit codes match the v0.1 convention:
 *   0 = would succeed (or uncertain — see --strict)
 *   1 = usage error
 *   2 = would fail OR runtime error
 *
 * Flow:
 *   1. GET <service-url> (no X-PAYMENT) → expect 402 + challenge body
 *   2. Decode challenge via the v0.1 `parseChallengeBody`
 *   3. Synthesise a `PaymentPayload` that would satisfy the challenge
 *      (so payment-side rules can sanity-check the requirements
 *      *themselves* — e.g. invalid asset, weird scheme — before we
 *      worry about wallet state).
 *   4. Query: USDC balance, EIP-3009 nonce state for the synthesised
 *      nonce, wallet kind.
 *   5. Build context + run engine + render.
 */

import { createChainClient, type Address, type ChainClient } from "../chain/index.js";
import { parseChainOrUndefined } from "./chain-flag.js";
import {
  parseFacilitatorList,
  runFacilitatorDiff,
  type DiffFetcher,
} from "./validate-facilitator-diff.js";
import { parseChallengeBody } from "../decoder/parse.js";
import type { LogFormat, PaymentPayload, PaymentRequirements } from "../decoder/types.js";
import { diagnose, formatReportHuman, formatReportJson } from "../diagnose/index.js";
import type { DiagnosticContext, WalletState } from "../diagnose/types.js";
import { createColorizer, type Colorizer } from "./color.js";
import { EXIT_RUNTIME, EXIT_SUCCESS, EXIT_USAGE, type ExitCode } from "./exit-codes.js";

export interface ValidateCommandOptions {
  readonly wallet?: string;
  readonly service?: string;
  readonly log?: LogFormat;
  readonly rpcUrl?: string;
  /**
   * Chain selection per ADR-003. Default `"base-sepolia"`. `"base"`
   * enables Base mainnet support; an RPC URL must be supplied (no
   * default mainnet endpoint).
   */
  readonly chain?: "base-sepolia" | "base";
  /**
   * When true, the "uncertain" overall status (key chain checks
   * skipped) exits 2 instead of 0. Default false — `uncertain` is a
   * warning, not a failure, since the user might have an RPC outage.
   */
  readonly strict?: boolean;
  /**
   * X402-35 — cross-facilitator drift mode. Comma-separated list of
   * facilitator aliases or full URLs (`cdp,xpay` or `https://...`).
   * When set, validate runs the same synthesised payload against each
   * facilitator's /verify endpoint and reports the drift instead of
   * (or in addition to) the standard single-facilitator validate
   * output.
   */
  readonly diff?: string;
  /** Per-facilitator /verify timeout in ms. Default 10_000. */
  readonly diffTimeoutMs?: number;
}

export interface ValidateRunContext {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly color?: Colorizer;
  /**
   * Injectable chain-client factory so tests can mock without standing
   * up a real RPC. Receives the resolved `chain` and `rpcUrl` (both
   * possibly undefined) so tests can assert mainnet routing without
   * touching the network. Defaults to `createChainClient`.
   */
  readonly chainFactory?: (rpcUrl?: string, chain?: "base-sepolia" | "base") => ChainClient;
  /** Injectable fetch for the 402 GET. Defaults to global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Injectable fetch for the --diff /verify POSTs. Defaults to global `fetch`. */
  readonly diffFetcher?: DiffFetcher;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
// Conservative synthesised nonce — all-zero. The nonce-fresh rule will
// query `authorizationState` for it; an unused all-zero nonce will
// almost certainly come back `false` (i.e. fresh), so the simulation
// is realistic for a wallet that hasn't paid this service yet.
const SYNTHESISED_NONCE = `0x${"0".repeat(64)}` as const;

export async function runValidateCommand(
  opts: ValidateCommandOptions,
  ctx: ValidateRunContext,
): Promise<ExitCode> {
  if (!opts.wallet || !opts.service) {
    ctx.stderr.write("error: usage — x402trace validate <wallet> <service-url>\n");
    return EXIT_USAGE;
  }
  if (!ADDRESS_RE.test(opts.wallet)) {
    ctx.stderr.write(`error: wallet is not a valid 0x-prefixed 20-byte address: ${opts.wallet}\n`);
    return EXIT_USAGE;
  }
  const wallet = opts.wallet as Address;
  let serviceUrl: URL;
  try {
    serviceUrl = new URL(opts.service);
  } catch {
    ctx.stderr.write(`error: service is not a valid URL: ${opts.service}\n`);
    return EXIT_USAGE;
  }

  const format: LogFormat = opts.log ?? "human";
  const color = ctx.color ?? createColorizer({ stream: ctx.stdout as { isTTY?: boolean } });
  const fetchFn = ctx.fetch ?? fetch;
  const now = (ctx.now ?? (() => new Date()))();

  // ─── Step 1: fetch the 402 challenge ───────────────────────────
  let challenge: PaymentRequirements;
  try {
    const res = await fetchFn(serviceUrl.toString(), { method: "GET" });
    if (res.status !== 402) {
      ctx.stderr.write(
        `error: expected ${color.paint("bold", "402")} from ${serviceUrl}, got ${res.status} — is this an x402-protected endpoint?\n`,
      );
      return EXIT_RUNTIME;
    }
    const bodyText = await res.text();
    const parsed = parseChallengeBody(bodyText);
    if (!parsed.ok) {
      ctx.stderr.write(`error: ${parsed.message}\n`);
      return EXIT_RUNTIME;
    }
    challenge = parsed.value.requirements;
  } catch (err) {
    ctx.stderr.write(
      `error: failed to fetch ${serviceUrl}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return EXIT_RUNTIME;
  }

  // ─── Step 2: synthesise a PaymentPayload the wallet WOULD sign ─
  // Pre-flight has no real signature; we synthesise the auth so the
  // payment-side rules can lint the challenge shape itself. The
  // validBefore is set to (now + maxTimeoutSeconds), matching what a
  // well-behaved client would produce.
  const validBeforeSec = Math.floor(now.getTime() / 1000) + (challenge.maxTimeoutSeconds ?? 300);
  const synthesised: PaymentPayload = {
    x402Version: 1,
    scheme: challenge.scheme,
    network: challenge.network,
    payload: {
      signature: "[SIMULATED]",
      authorization: {
        from: wallet,
        to: challenge.payTo,
        value: challenge.maxAmountRequired,
        validAfter: "0",
        validBefore: String(validBeforeSec),
        nonce: SYNTHESISED_NONCE,
      },
    },
  };

  // ─── Step 3: query on-chain wallet state ───────────────────────
  const chainKey: "base-sepolia" | "base" =
    opts.chain ?? parseChainOrUndefined(ctx.env.BASE_CHAIN_ID) ?? "base-sepolia";
  if (chainKey === "base") {
    ctx.stderr.write(
      `${color.paint("yellow", "⚠ MAINNET (chain=base):")} querying Base mainnet USDC for ${wallet}\n`,
    );
  }
  const chainFactory =
    ctx.chainFactory ??
    ((rpcUrl?: string, c?: "base-sepolia" | "base") =>
      createChainClient({ ...(rpcUrl ? { rpcUrl } : {}), ...(c ? { chain: c } : {}) }));
  const chain = chainFactory(opts.rpcUrl ?? ctx.env.BASE_RPC_URL, chainKey);
  let walletState: WalletState;
  try {
    const [balance, nonceConsumed, walletKind] = await Promise.all([
      chain.getUsdcBalance(wallet),
      chain.isNonceConsumed(wallet, SYNTHESISED_NONCE),
      chain.detectWalletKind(wallet),
    ]);
    walletState = { usdcBalance: balance, nonceConsumed, walletKind };
  } catch (err) {
    ctx.stderr.write(
      `${color.paint("yellow", "warn:")} chain state query failed — running offline diagnosis only (${err instanceof Error ? err.message : String(err)})\n`,
    );
    walletState = {};
  } finally {
    await chain.close?.();
  }

  // ─── Step 4: build context, run engine, render ────────────────
  const diagCtx: DiagnosticContext = {
    requirements: challenge,
    payment: synthesised,
    walletState,
    now,
  };

  // ─── Step 4b: X402-35 cross-facilitator diff (opt-in via --diff) ──
  if (opts.diff) {
    const parsed = parseFacilitatorList(opts.diff);
    if (!parsed.ok) {
      ctx.stderr.write(`error: ${parsed.message}\n`);
      return EXIT_USAGE;
    }
    const diffOpts: { fetcher?: DiffFetcher; timeoutMs?: number } = {
      ...(ctx.diffFetcher !== undefined ? { fetcher: ctx.diffFetcher } : {}),
      ...(opts.diffTimeoutMs !== undefined ? { timeoutMs: opts.diffTimeoutMs } : {}),
    };
    const aggregate = await runFacilitatorDiff(
      parsed.facilitators,
      { paymentPayload: synthesised, paymentRequirements: challenge },
      diagCtx,
      diffOpts,
    );
    if (format === "human") {
      ctx.stdout.write(
        `${color.paint("bold", `validate --diff ${wallet}`)}  →  ${color.paint("dim", serviceUrl.toString())}\n`,
      );
      ctx.stdout.write(`${formatDiffHuman(aggregate, color)}\n`);
    } else {
      ctx.stdout.write(`${JSON.stringify(aggregate)}\n`);
    }
    return aggregate.verdict.exitCode as ExitCode;
  }

  const report = diagnose(diagCtx);

  if (format === "human") {
    // One-line header so users see what was checked at a glance.
    ctx.stdout.write(
      `${color.paint("bold", `validate ${wallet}`)}  →  ${color.paint("dim", serviceUrl.toString())}\n`,
    );
    ctx.stdout.write(`${formatReportHuman(report, color)}\n`);
  } else {
    ctx.stdout.write(`${formatReportJson(report)}\n`);
  }

  // ─── Step 5: exit code ─────────────────────────────────────────
  if (report.overallStatus === "would-fail") return EXIT_RUNTIME;
  if (report.overallStatus === "uncertain" && opts.strict) return EXIT_RUNTIME;
  return EXIT_SUCCESS;
}

// ─── X402-35: diff renderer ───────────────────────────────────────

function formatDiffHuman(
  aggregate: Awaited<ReturnType<typeof runFacilitatorDiff>>,
  color: Colorizer,
): string {
  const lines: string[] = [];
  for (const r of aggregate.results) {
    const status = r.accepted
      ? color.paint("green", "✓ ACCEPTED")
      : r.timedOut
        ? color.paint("yellow", "○ TIMED OUT")
        : color.paint("red", "✗ REJECTED");
    const reason =
      r.interaction.response?.invalidReason ??
      r.interaction.response?.errorReason ??
      r.interaction.errorMessage ??
      "";
    lines.push(
      `  ${status}  ${color.paint("bold", r.facilitator.id)}  ` +
        `${color.paint("dim", `(HTTP ${r.interaction.statusCode})`)}` +
        (reason ? `  ${color.paint("dim", `— ${reason}`)}` : ""),
    );
    // Surface any failing rules per-facilitator (these are the
    // X402-33 facilitator-aware rules firing on the captured response).
    for (const ruleResult of r.diagnostics.results) {
      if (ruleResult.status === "fail") {
        lines.push(
          `      ${color.paint("red", "·")} ${color.paint("dim", ruleResult.rule)}: ${ruleResult.message}`,
        );
      }
    }
  }
  lines.push("");
  const v = aggregate.verdict;
  if (v.kind === "any_accepts") {
    lines.push(color.paint("green", `✓ VERDICT (exit 0): accepted by ${v.accepted.join(", ")}`));
  } else if (v.kind === "all_reject") {
    lines.push(
      color.paint(
        "red",
        `✗ VERDICT (exit 2): all facilitators rejected the payload (${v.rejected.join(", ")}). Inspect per-rule reasons above to identify the drift.`,
      ),
    );
  } else {
    lines.push(
      color.paint(
        "yellow",
        `○ VERDICT (exit 3): all facilitators timed out. Retry with --diff-timeout-ms or check network reachability.`,
      ),
    );
  }
  return lines.join("\n");
}
