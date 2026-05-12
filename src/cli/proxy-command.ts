/**
 * `x402trace proxy` — start the local HTTP proxy with live decoder +
 * (optionally) chain subscription + reconciliation engine.
 *
 * Wires together the four substrates built across X402-10 → X402-13.
 * Per [SPEC.md § 3 user flow](../../SPEC.md#3-user-flow) the headline
 * line is `RECONCILED ⚠ settled-but-server-thinks-not`; that's rendered
 * here (via `format-result.ts`) and persisted to JSONL as a
 * `reconcile.result` record — the canonical artifact downstream tools
 * read.
 *
 * Closes the X402-13 deferred acceptance bullet: every emitted
 * `ReconciliationResult` and every observed `ChainTransfer` is written
 * to the same JSONL log as the proxy events.
 */

import { createChainClient } from "../chain/index.js";
import type { ChainTransfer } from "../chain/types.js";
import { createDecoder, formatHuman, formatJson, type LogFormat } from "../decoder/index.js";
import { JsonlSink } from "../proxy/jsonl-sink.js";
import { createProxy } from "../proxy/index.js";
import { createReconciliationEngine } from "../reconciliation/index.js";
import type { ReconciliationResult } from "../reconciliation/types.js";
import { createColorizer, type Colorizer } from "./color.js";
import { EXIT_RUNTIME, EXIT_SUCCESS, EXIT_USAGE, type ExitCode } from "./exit-codes.js";
import { formatResultHuman, formatResultJson } from "./format-result.js";
import { chainTransferToJsonl } from "./replay.js";

export interface ProxyCommandOptions {
  readonly upstream?: string;
  readonly port?: number;
  readonly logFile?: string;
  readonly log?: LogFormat;
  readonly logSecrets?: boolean;
  readonly reconcile?: boolean;
  readonly rpcUrl?: string;
  readonly watchTimeoutMs?: number;
  readonly upstreamTimeoutMs?: number;
}

export interface RunContext {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Resolves with the chosen exit code once SIGINT/SIGTERM is observed. */
  readonly waitForShutdown: () => Promise<void>;
  readonly color?: Colorizer;
}

const DEFAULT_PORT = 8402;
const DEFAULT_LOG_PATH = "./x402trace.jsonl";
const DEFAULT_WATCH_TIMEOUT_MS = 60_000;

/**
 * Run the `proxy` subcommand. Returns the exit code; callers
 * (`src/cli.ts`) translate this to `process.exit`. Tests inject a
 * fast-resolving `waitForShutdown` so the command can run end-to-end
 * without a real signal.
 */
export async function runProxyCommand(
  opts: ProxyCommandOptions,
  ctx: RunContext,
): Promise<ExitCode> {
  const upstream = opts.upstream ?? ctx.env.X402TRACE_UPSTREAM;
  if (!upstream) {
    ctx.stderr.write("error: --upstream is required\n");
    return EXIT_USAGE;
  }

  const port = opts.port ?? toIntOrNull(ctx.env.X402TRACE_PORT) ?? DEFAULT_PORT;
  const logPath = opts.logFile ?? ctx.env.X402TRACE_LOG ?? DEFAULT_LOG_PATH;
  const format: LogFormat = opts.log ?? "human";
  const logSecrets = opts.logSecrets ?? false;
  const reconcile = opts.reconcile ?? truthy(ctx.env.X402TRACE_RECONCILE);
  const rpcUrl = opts.rpcUrl ?? ctx.env.BASE_RPC_URL;
  const watchTimeoutMs =
    opts.watchTimeoutMs ??
    toIntOrNull(ctx.env.X402TRACE_WATCH_TIMEOUT_MS) ??
    DEFAULT_WATCH_TIMEOUT_MS;

  const color = ctx.color ?? createColorizer({ stream: ctx.stdout as { isTTY?: boolean } });

  // The proxy owns its own JsonlSink for proxy events; we open a
  // SECOND sink against the same path for chain + reconcile events.
  // Both use O_APPEND so kernel-level atomicity covers per-line writes.
  const upstreamTimeoutMs =
    opts.upstreamTimeoutMs ?? toIntOrNull(ctx.env.X402TRACE_UPSTREAM_TIMEOUT_MS) ?? undefined;
  const proxyHandle = await createProxy({
    upstream,
    port,
    logPath,
    ...(upstreamTimeoutMs !== undefined ? { upstreamTimeoutMs } : {}),
  });
  const sideSink = new JsonlSink(logPath);
  await sideSink.open();

  ctx.stdout.write(
    color.paint("bold", `x402trace proxy listening on ${proxyHandle.url}`) + `  →  ${upstream}\n`,
  );
  ctx.stdout.write(
    `${color.paint("dim", "log:")} ${logPath}  ${color.paint("dim", "format:")} ${format}  ${color.paint("dim", "secrets:")} ${logSecrets ? "shown" : "redacted"}  ${color.paint("dim", "reconcile:")} ${reconcile ? "on" : "off"}\n`,
  );

  const decoder = createDecoder({ logSecrets });
  const engine = reconcile ? createReconciliationEngine({ watchTimeoutMs }) : null;
  const chain = reconcile ? createChainClient({ ...(rpcUrl ? { rpcUrl } : {}) }) : null;

  // --- Proxy / decoder event loop ---
  const proxySub = proxyHandle.events.subscribe();
  const proxyTask = (async () => {
    for await (const event of proxySub) {
      if (event.event === "exchange.opened") {
        ctx.stdout.write(
          `${color.paint("dim", `[${event.t}]`)} HTTP ${event.request.method} ${event.request.path} (id=${event.id.slice(0, 8)})\n`,
        );
      } else if (event.event === "exchange.closed") {
        ctx.stdout.write(
          `${color.paint("dim", `[${event.t}]`)} HTTP ${event.response.status} ${event.outcome.kind} (id=${event.id.slice(0, 8)}, ${event.durationMs}ms)\n`,
        );
      } else if (event.event === "proxy.error") {
        ctx.stderr.write(`${color.paint("red", `[${event.t}] proxy error:`)} ${event.message}\n`);
      }

      engine?.ingestProxyEvent(event);
      for (const decoded of decoder.decode(event)) {
        engine?.ingestDecoderEvent(decoded);
        ctx.stdout.write(
          format === "human" ? `  ${formatHuman(decoded)}\n` : `${formatJson(decoded)}\n`,
        );
      }
    }
  })();

  // --- Chain subscription (only when --reconcile) ---
  let chainSub: (AsyncIterable<ChainTransfer> & { unsubscribe(): void }) | null = null;
  let chainTask: Promise<void> | null = null;
  if (engine && chain) {
    chainSub = chain.subscribeUsdcTransfers();
    chainTask = (async () => {
      try {
        for await (const transfer of chainSub!) {
          sideSink.append(chainTransferToJsonl(transfer, new Date().toISOString()));
          engine.ingestChainTransfer(transfer);
        }
      } catch (err) {
        ctx.stderr.write(`${color.paint("red", "chain subscription error:")} ${errMsg(err)}\n`);
      }
    })();
  }

  // --- Reconciliation result loop ---
  let resultSub: (AsyncIterable<ReconciliationResult> & { unsubscribe(): void }) | null = null;
  let resultTask: Promise<void> | null = null;
  if (engine) {
    resultSub = engine.results();
    resultTask = (async () => {
      for await (const result of resultSub!) {
        sideSink.append({ event: "reconcile.result", ...serialiseBigints(result) });
        ctx.stdout.write(
          format === "human"
            ? `${formatResultHuman(result, color)}\n`
            : `${formatResultJson(result)}\n`,
        );
      }
    })();
  }

  // --- Wait for shutdown ---
  try {
    await ctx.waitForShutdown();
  } catch (err) {
    ctx.stderr.write(`${color.paint("red", "runtime error:")} ${errMsg(err)}\n`);
    await teardown();
    return EXIT_RUNTIME;
  }

  await teardown();
  return EXIT_SUCCESS;

  async function teardown(): Promise<void> {
    proxySub.unsubscribe();
    resultSub?.unsubscribe();
    chainSub?.unsubscribe();
    await proxyHandle.close();
    await chain?.close();
    await engine?.close();
    await sideSink.close();
    await proxyTask;
    if (resultTask) await resultTask;
    if (chainTask) await chainTask;
  }
}

/**
 * Returns a copy of `result` where any embedded `bigint` is coerced to
 * a string so `JSON.stringify` doesn't throw. The strings round-trip
 * via `BigInt(str)` in the replay reader.
 */
function serialiseBigints(result: ReconciliationResult): Record<string, unknown> {
  // Walk one level deep — the only bigints are in `onChain` (ChainTransfer)
  // and the top-level `expected`/`actual` of value_mismatch.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result)) {
    if (typeof v === "bigint") {
      out[k] = v.toString();
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      const nested: Record<string, unknown> = {};
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        nested[k2] = typeof v2 === "bigint" ? v2.toString() : v2;
      }
      out[k] = nested;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function toIntOrNull(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function truthy(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
