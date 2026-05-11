/**
 * Minimal CLI entry for `x402trace proxy`. The full multi-subcommand CLI
 * is X402-14; this script is just enough to satisfy X402-10's acceptance
 * criterion: `npx x402trace proxy --upstream <url>` (we run it locally
 * as `pnpm proxy -- --upstream <url>` or `tsx scripts/proxy.ts --upstream <url>`).
 */
import "dotenv/config";
import { createProxy } from "../src/proxy/index.js";

interface Args {
  upstream?: string;
  port?: number;
  log?: string;
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
    } else if (a === "--log" && argv[i + 1]) {
      args.log = argv[++i];
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
  tsx scripts/proxy.ts --upstream <url> [--port <n>] [--log <path>]

Options:
  --upstream <url>   Upstream HTTP base URL (required)
  --port <n>         Listen port (default 8402)
  --log <path>       JSONL log file (default: stdout-only, no file)
  -h, --help         Show this message
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
  const logPath = args.log ?? process.env.X402TRACE_LOG ?? "./x402trace.jsonl";

  const handle = await createProxy({
    upstream: args.upstream,
    port,
    logPath,
  });

  console.log(`x402trace proxy listening on ${handle.url}  →  ${args.upstream}`);
  console.log(`log: ${logPath}`);

  // Subscribe to events for stdout summary.
  const sub = handle.events.subscribe();
  (async () => {
    for await (const event of sub) {
      if (event.event === "exchange.opened") {
        console.log(
          `[${event.t}] ${event.request.method} ${event.request.path} (id=${event.id.slice(0, 8)})`,
        );
      } else if (event.event === "exchange.closed") {
        const kind = event.outcome.kind;
        const tag =
          kind === "paid"
            ? "✓"
            : kind === "rejected"
              ? "402"
              : kind === "upstream_timeout"
                ? "⏱"
                : "·";
        console.log(
          `[${event.t}] ${tag} ${event.response.status} ${kind} (id=${event.id.slice(0, 8)}, ${event.durationMs}ms)`,
        );
      } else if (event.event === "proxy.error") {
        console.error(`[${event.t}] error: ${event.message}`);
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
