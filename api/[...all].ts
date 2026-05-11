import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

// NOTE: Vercel's serverless function build invokes tsc with a lib/types set
// where the global Web Fetch types (Request, Response, RequestInit, Headers)
// resolve as empty shells, so any property access fails to type-check. Our
// LOCAL tsconfig sees the full types via @types/node@22. To compile in both
// places, this file deliberately avoids referencing those globals as named
// types and works through `any`/`unknown` with runtime guards.
//
// Don't tighten the types here without re-running the Vercel build first.

let initError: Error | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let appFetch: ((req: any) => Promise<any>) | null = null;

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  appFetch = async (req: any) => app.fetch(req);
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const HeadersCtor = (globalThis as any).Headers;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const RequestCtor = (globalThis as any).Request;
    const headers = new HeadersCtor();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) headers.set(name, value.join(", "));
      else if (typeof value === "string") headers.set(name, value);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const init: any = { method: req.method ?? "GET", headers };
    if (req.method && req.method !== "GET" && req.method !== "HEAD") {
      init.body = Readable.toWeb(req);
      init.duplex = "half";
    }

    console.log("[req] dispatching to Hono", { url });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const webRes: any = await appFetch(new RequestCtor(url, init));
    console.log(`[req] Hono returned status=${webRes.status} in ${Date.now() - t0}ms`);

    res.statusCode = webRes.status;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    webRes.headers.forEach((v: string, k: string) => res.setHeader(k, v));
    if (webRes.body) {
      Readable.fromWeb(webRes.body).pipe(res);
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
