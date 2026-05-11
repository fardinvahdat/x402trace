/**
 * Minimal CLI entry for `x402trace proxy`. The full multi-subcommand CLI
 * is X402-14; this script is just enough to satisfy X402-10's acceptance
 * criterion: `npx x402trace proxy --upstream <url>` (we run it locally
 * as `pnpm proxy -- --upstream <url>` or `tsx scripts/proxy.ts --upstream <url>`).
 *
 * X402-11 added the decoder, surfaced via `--log=human` (default) /
 * `--log=json`, and `--log-secrets` to keep raw signatures.
 */
import "dotenv/config";
import { createProxy } from "../src/proxy/index.js";
import { createDecoder, formatHuman, formatJson, type LogFormat } from "../src/decoder/index.js";

interface Args {
  upstream?: string;
  port?: number;
  logFile?: string;
  format?: LogFormat;
  logSecrets?: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--upstream" && argv[i + 1]) {
      args.upstream = argv[++i];
    } else if (a === "--port" && argv[i + 1]) {
      const next = argv[++i];
      if (next) args.port = Number(next);
    } else if ((a === "--log-file" || a === "--logfile") && argv[i + 1]) {
      args.logFile = argv[++i];
    } else if (a === "--log" && argv[i + 1]) {
      const v = argv[++i];
      if (v === "human" || v === "json") args.format = v;
      else {
        console.error(`error: --log must be 'human' or 'json' (got '${v ?? ""}')`);
        process.exit(2);
      }
    } else if (a === "--log-secrets") {
      args.logSecrets = true;
    } else if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    }
  }
  return args;
}

function printUsage(): void {
  console.log(`x402trace proxy — capture x402 HTTP traffic to JSONL

Usage:
  tsx scripts/proxy.ts --upstream <url> [options]

Options:
  --upstream <url>     Upstream HTTP base URL (required)
  --port <n>           Listen port (default 8402)
  --log-file <path>    JSONL log file (default ./x402trace.jsonl)
  --log <human|json>   Stdout format (default 'human')
  --log-secrets        Print full EIP-3009 signatures (default: redacted)
  -h, --help           Show this message
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.upstream) {
    console.error("error: --upstream is required");
    printUsage();
    process.exit(2);
  }

  const port = args.port ?? Number(process.env.X402TRACE_PORT ?? 8402);
  const logPath = args.logFile ?? process.env.X402TRACE_LOG ?? "./x402trace.jsonl";
  const format: LogFormat = args.format ?? "human";
  const logSecrets = args.logSecrets ?? false;

  const handle = await createProxy({ upstream: args.upstream, port, logPath });
  const decoder = createDecoder({ logSecrets });

  console.log(`x402trace proxy listening on ${handle.url}  →  ${args.upstream}`);
  console.log(`log: ${logPath}  format: ${format}  secrets: ${logSecrets ? "shown" : "redacted"}`);

  // Subscribe to events. Render both raw HTTP summary lines and decoder output.
  const sub = handle.events.subscribe();
  (async () => {
    for await (const event of sub) {
      // Raw HTTP summary line (one per opened/closed/error).
      if (event.event === "exchange.opened") {
        console.log(
          `[${event.t}] HTTP ${event.request.method} ${event.request.path} (id=${event.id.slice(0, 8)})`,
        );
      } else if (event.event === "exchange.closed") {
        console.log(
          `[${event.t}] HTTP ${event.response.status} ${event.outcome.kind} (id=${event.id.slice(0, 8)}, ${event.durationMs}ms)`,
        );
      } else if (event.event === "proxy.error") {
        console.error(`[${event.t}] proxy error: ${event.message}`);
      }

      // Decoded events (challenge / payment / settlement / decoder.error).
      for (const decoded of decoder.decode(event)) {
        console.log(format === "human" ? `  ${formatHuman(decoded)}` : formatJson(decoded));
      }
    }
  })().catch((err) => {
    console.error("event subscriber crashed:", err);
  });

  const shutdown = async (sig: string): Promise<void> => {
    console.log(`\n${sig} received, shutting down…`);
    sub.unsubscribe();
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
