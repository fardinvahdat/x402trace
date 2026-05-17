/**
 * CLI surface. Four subcommands:
 *
 *   x402trace proxy    --upstream <url> [--reconcile] [--log human|json] …    (X402-14)
 *   x402trace inspect  <jsonl-log-file> [--log human|json] …                  (X402-14)
 *   x402trace validate <wallet> <service-url> [--strict] [--log human|json]   (X402-21 v0.2)
 *   x402trace explain  <jsonl-log-file> [--log human|json]                    (X402-21 v0.2)
 *
 * `commander` does the parsing; we own the wiring + exit-code
 * discipline.
 *
 * `runCli` is the testable entry; `src/cli.ts` is the bin shim that
 * calls it with the real `process` handles.
 */

import "dotenv/config";
import { Command } from "commander";
import type { LogFormat } from "../decoder/types.js";
import { runBazaarCheckCommand } from "./bazaar-check-command.js";
import { runExplainCommand } from "./explain-command.js";
import { runInspectCommand } from "./inspect-command.js";
import { runProxyCommand } from "./proxy-command.js";
import { runValidateCommand } from "./validate-command.js";
import { runVersionsCommand } from "./versions-command.js";
import { EXIT_SUCCESS, EXIT_USAGE, type ExitCode } from "./exit-codes.js";

// Keep in sync with package.json `version`. A runtime read from
// package.json would be more durable but requires JSON-module
// resolution gymnastics in NodeNext + a relative path that works for
// both `tsx src/cli.ts` (dev) and `dist/cli.js` (published) — folding
// that into a follow-up cleanup. Until then, the X402-19 release
// checklist + the changelog-cut step are the guards against drift.
const VERSION = "0.2.3";

export interface CliContext {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Resolves when the process should shut down (SIGINT/SIGTERM in
   * production, immediately for many tests). Only consulted by the
   * long-running `proxy` subcommand.
   */
  readonly waitForShutdown?: () => Promise<void>;
}

interface ProxyFlags {
  upstream?: string;
  port?: string;
  log?: string;
  logFile?: string;
  logSecrets?: boolean;
  reconcile?: boolean;
  rpcUrl?: string;
  chain?: string;
  watchTimeoutMs?: string;
  upstreamTimeoutMs?: string;
}

interface InspectFlags {
  log?: string;
  watchTimeoutMs?: string;
  chain?: string;
}

interface ValidateFlags {
  log?: string;
  rpcUrl?: string;
  chain?: string;
  strict?: boolean;
  diff?: string;
  diffTimeoutMs?: string;
}

interface ExplainFlags {
  log?: string;
}

interface BazaarCheckFlags {
  log?: string;
  chain?: string;
  payerHint?: string;
  discoveryBaseUrl?: string;
}

interface VersionsFlags {
  log?: string;
}

function validateChain(value: string): "base-sepolia" | "base" {
  if (value !== "base-sepolia" && value !== "base") {
    throw new Error(`--chain must be 'base-sepolia' or 'base' (got '${value}')`);
  }
  return value;
}

export async function runCli(argv: readonly string[], ctx: CliContext): Promise<ExitCode> {
  const program = new Command();
  program
    .name("x402trace")
    .description(
      "Local CLI for debugging x402 payment flows on Base — catches timeout reconciliation failures.",
    )
    .version(VERSION, "-v, --version")
    .helpOption("-h, --help", "Show this message")
    .configureOutput({
      writeOut: (str) => ctx.stdout.write(str),
      writeErr: (str) => ctx.stderr.write(str),
    })
    // commander would call process.exit on parse errors; we route it
    // through our own exit-code constants instead.
    .exitOverride();

  let exit: ExitCode = EXIT_SUCCESS;

  program
    .command("proxy")
    .description("Start the local HTTP proxy with live x402 capture and reconciliation.")
    .requiredOption("--upstream <url>", "Upstream HTTP base URL to forward to")
    .option("--port <n>", "Listen port (default 8402)")
    .option("--log <human|json>", "Stdout format (default 'human')", validateLogFormat)
    .option(
      "--log-file <path>",
      "JSONL log file path (default ./x402trace.jsonl, env X402TRACE_LOG)",
    )
    .option(
      "--log-secrets",
      "Keep raw EIP-3009 signatures in the log instead of redacting (default off)",
    )
    .option(
      "--reconcile",
      "Subscribe to the chain and reconcile facilitator rejections against on-chain settlements",
    )
    .option("--rpc-url <url>", "RPC URL for the chosen chain (env BASE_RPC_URL)")
    .option(
      "--chain <base-sepolia|base>",
      "Chain to watch for reconciliation (default 'base-sepolia'; 'base' requires --rpc-url, no default mainnet URL)",
      validateChain,
    )
    .option(
      "--watch-timeout-ms <n>",
      "How long to watch the chain for a rejected exchange before giving up (default 60000)",
    )
    .option(
      "--upstream-timeout-ms <n>",
      "Per-request timeout to the upstream server; on timeout the proxy emits `upstream_timeout` and returns 502 (default 30000)",
    )
    .action(async (flags: ProxyFlags) => {
      const log = flags.log as LogFormat | undefined;
      const chain = flags.chain as "base-sepolia" | "base" | undefined;
      exit = await runProxyCommand(
        {
          ...(flags.upstream !== undefined ? { upstream: flags.upstream } : {}),
          ...(flags.port !== undefined ? { port: Number(flags.port) } : {}),
          ...(flags.logFile !== undefined ? { logFile: flags.logFile } : {}),
          ...(log !== undefined ? { log } : {}),
          ...(flags.logSecrets !== undefined ? { logSecrets: flags.logSecrets } : {}),
          ...(flags.reconcile !== undefined ? { reconcile: flags.reconcile } : {}),
          ...(flags.rpcUrl !== undefined ? { rpcUrl: flags.rpcUrl } : {}),
          ...(chain !== undefined ? { chain } : {}),
          ...(flags.watchTimeoutMs !== undefined
            ? { watchTimeoutMs: Number(flags.watchTimeoutMs) }
            : {}),
          ...(flags.upstreamTimeoutMs !== undefined
            ? { upstreamTimeoutMs: Number(flags.upstreamTimeoutMs) }
            : {}),
        },
        {
          stdout: ctx.stdout,
          stderr: ctx.stderr,
          env: ctx.env,
          waitForShutdown: ctx.waitForShutdown ?? defaultWaitForSignals,
        },
      );
    });

  program
    .command("inspect")
    .description("Replay a captured JSONL log and re-run reconciliation offline.")
    .argument("<jsonl-log-file>", "Path to a JSONL log written by `x402trace proxy --reconcile`")
    .option("--log <human|json>", "Stdout format (default 'human')", validateLogFormat)
    .option("--watch-timeout-ms <n>", "Watch window applied during replay (default 60000)")
    .option(
      "--chain <base-sepolia|base>",
      "Chain context for the replay (default 'base-sepolia'; should match the capture)",
      validateChain,
    )
    .action(async (logFile: string, flags: InspectFlags) => {
      const log = flags.log as LogFormat | undefined;
      const chain = flags.chain as "base-sepolia" | "base" | undefined;
      exit = await runInspectCommand(
        {
          logFile,
          ...(log !== undefined ? { log } : {}),
          ...(flags.watchTimeoutMs !== undefined
            ? { watchTimeoutMs: Number(flags.watchTimeoutMs) }
            : {}),
          ...(chain !== undefined ? { chain } : {}),
        },
        { stdout: ctx.stdout, stderr: ctx.stderr },
      );
    });

  program
    .command("validate")
    .description(
      "Pre-flight check: would <wallet> succeed paying <service-url>? Read-only, no signing.",
    )
    .argument("<wallet>", "Payer wallet address (0x-prefixed, 20 bytes)")
    .argument("<service-url>", "Service URL that responds 402 with an x402 challenge")
    .option("--log <human|json>", "Stdout format (default 'human')", validateLogFormat)
    .option("--rpc-url <url>", "RPC URL for the chosen chain (env BASE_RPC_URL)")
    .option(
      "--chain <base-sepolia|base>",
      "Chain to query for wallet state (default 'base-sepolia'; 'base' requires --rpc-url)",
      validateChain,
    )
    .option(
      "--strict",
      "Treat `uncertain` (key chain checks skipped) as a failure — exit 2 instead of 0",
    )
    .option(
      "--diff <facilitators>",
      "Cross-facilitator drift: comma-separated list of aliases (cdp, xpay, payai, x402.org) OR full URLs. Runs /verify against each in parallel and reports drift.",
    )
    .option(
      "--diff-timeout-ms <n>",
      "Per-facilitator /verify timeout in --diff mode (default 10000)",
    )
    .action(async (wallet: string, service: string, flags: ValidateFlags) => {
      const log = flags.log as LogFormat | undefined;
      const chain = flags.chain as "base-sepolia" | "base" | undefined;
      exit = await runValidateCommand(
        {
          wallet,
          service,
          ...(log !== undefined ? { log } : {}),
          ...(flags.rpcUrl !== undefined ? { rpcUrl: flags.rpcUrl } : {}),
          ...(chain !== undefined ? { chain } : {}),
          ...(flags.strict !== undefined ? { strict: flags.strict } : {}),
          ...(flags.diff !== undefined ? { diff: flags.diff } : {}),
          ...(flags.diffTimeoutMs !== undefined
            ? { diffTimeoutMs: Number(flags.diffTimeoutMs) }
            : {}),
        },
        { stdout: ctx.stdout, stderr: ctx.stderr, env: ctx.env },
      );
    });

  program
    .command("explain")
    .description(
      "Plain-English diagnosis of every failed exchange in a captured JSONL log. Offline.",
    )
    .argument("<jsonl-log-file>", "Path to a JSONL log written by `x402trace proxy --reconcile`")
    .option("--log <human|json>", "Stdout format (default 'human')", validateLogFormat)
    .action(async (logFile: string, flags: ExplainFlags) => {
      const log = flags.log as LogFormat | undefined;
      exit = await runExplainCommand(
        {
          logFile,
          ...(log !== undefined ? { log } : {}),
        },
        { stdout: ctx.stdout, stderr: ctx.stderr },
      );
    });

  program
    .command("versions")
    .description(
      "SDK skew audit: compares local package.json @x402/* versions + service 402 version hints against a bundled known-skew table.",
    )
    .argument("<service-url>", "Service URL that responds 402 with an x402 challenge")
    .option("--log <human|json>", "Stdout format (default 'human')", validateLogFormat)
    .action(async (service: string, flags: VersionsFlags) => {
      const log = flags.log as LogFormat | undefined;
      exit = await runVersionsCommand(
        {
          service,
          ...(log !== undefined ? { log } : {}),
        },
        { stdout: ctx.stdout, stderr: ctx.stderr },
      );
    });

  program
    .command("bazaar-check")
    .description(
      "Pre-ship Bazaar / agentic.market validator: well-known manifest, 402 challenge, indexing status. Read-only.",
    )
    .argument("<service-url>", "Service URL that responds 402 with an x402 challenge")
    .option("--log <human|json>", "Stdout format (default 'human')", validateLogFormat)
    .option(
      "--chain <base-sepolia|base>",
      "Chain for the Bazaar indexing query (default 'base-sepolia')",
      validateChain,
    )
    .option(
      "--payer-hint <address>",
      "Optional payer address; enables the self-payment guard (flags payer == payTo)",
    )
    .option(
      "--discovery-base-url <url>",
      "Override the CDP discovery base URL (default https://api.cdp.coinbase.com)",
    )
    .action(async (service: string, flags: BazaarCheckFlags) => {
      const log = flags.log as LogFormat | undefined;
      const chain = flags.chain as "base-sepolia" | "base" | undefined;
      exit = await runBazaarCheckCommand(
        {
          service,
          ...(log !== undefined ? { log } : {}),
          ...(chain !== undefined ? { chain } : {}),
          ...(flags.payerHint !== undefined ? { payerHint: flags.payerHint } : {}),
          ...(flags.discoveryBaseUrl !== undefined
            ? { discoveryBaseUrl: flags.discoveryBaseUrl }
            : {}),
        },
        { stdout: ctx.stdout, stderr: ctx.stderr, env: ctx.env },
      );
    });

  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (err) {
    // commander's `exitOverride()` throws a CommanderError on
    // help/version/usage exits. Translate.
    const code = (err as { code?: string }).code;
    const exitCode = (err as { exitCode?: number }).exitCode;
    if (code === "commander.helpDisplayed" || code === "commander.version") {
      return EXIT_SUCCESS;
    }
    if (exitCode !== undefined && exitCode !== 0) {
      return EXIT_USAGE;
    }
    ctx.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_USAGE;
  }

  return exit;
}

function validateLogFormat(value: string): LogFormat {
  if (value !== "human" && value !== "json") {
    throw new Error(`--log must be 'human' or 'json' (got '${value}')`);
  }
  return value;
}

/**
 * Production-mode shutdown gate: resolve on the first SIGINT or
 * SIGTERM. Used only by the long-running `proxy` subcommand.
 */
function defaultWaitForSignals(): Promise<void> {
  return new Promise((resolve) => {
    const onSig = (): void => {
      process.off("SIGINT", onSig);
      process.off("SIGTERM", onSig);
      resolve();
    };
    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);
  });
}
