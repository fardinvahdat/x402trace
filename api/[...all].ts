import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

// Module-level initialization wrapped so any failure surfaces in the
// response body instead of hanging Vercel until invocation timeout.
let initError: Error | null = null;
let appFetch: ((req: Request) => Promise<Response>) | null = null;

try {
  console.log("[init] loading config and Hono app");
  const { createDogfoodApp } = await import("../src/dogfood/app.js");
  const { loadServerConfig } = await import("../src/dogfood/config.js");
  const config = loadServerConfig();
  console.log("[init] config loaded:", {
    network: config.network,
    receiverAddress: config.receiverAddress,
    protectedPath: config.protectedPath,
  });
  const app = createDogfoodApp(config);
  appFetch = async (req: Request) => app.fetch(req);
  console.log("[init] Hono app ready");
} catch (err) {
  initError = err instanceof Error ? err : new Error(String(err));
  console.error("[init] failed:", initError);
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const t0 = Date.now();
  console.log(`[req] ${req.method} ${req.url}`);
  try {
    if (initError || !appFetch) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          error: "initialization_failed",
          message: initError?.message ?? "appFetch is null",
          stack: initError?.stack,
        }),
      );
      return;
    }

    const host = (req.headers["x-forwarded-host"] as string) ?? req.headers.host ?? "localhost";
    const proto = (req.headers["x-forwarded-proto"] as string) ?? "https";
    const url = `${proto}://${host}${req.url ?? "/"}`;

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) headers.set(name, value.join(", "));
      else if (typeof value === "string") headers.set(name, value);
    }

    const init: RequestInit & { duplex?: "half" } = {
      method: req.method ?? "GET",
      headers,
    };
    if (req.method && req.method !== "GET" && req.method !== "HEAD") {
      init.body = Readable.toWeb(req) as unknown as ReadableStream;
      init.duplex = "half";
    }

    console.log("[req] dispatching to Hono", { url });
    const webRes = await appFetch(new Request(url, init));
    console.log(`[req] Hono returned status=${webRes.status} in ${Date.now() - t0}ms`);

    res.statusCode = webRes.status;
    webRes.headers.forEach((v, k) => res.setHeader(k, v));
    if (webRes.body) {
      Readable.fromWeb(webRes.body as never).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    console.error("[req] handler error:", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          error: "handler_threw",
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        }),
      );
    } else {
      res.end();
    }
  }
}
