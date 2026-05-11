import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { createDogfoodApp } from "../src/dogfood/app.js";
import { loadServerConfig } from "../src/dogfood/config.js";

// Build the Hono app once per cold start.
const app = createDogfoodApp(loadServerConfig());

// Vercel Node runtime expects an (req, res) => void handler. We bridge that to
// Hono's Web Fetch API surface. Using hono/vercel's `handle` here was returning
// the Edge-style (req: Request) => Response signature, which Vercel's Node
// runtime did not recognize — the function hung until FUNCTION_INVOCATION_TIMEOUT.
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
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

    const webRes = await app.fetch(new Request(url, init));
    res.statusCode = webRes.status;
    webRes.headers.forEach((v, k) => res.setHeader(k, v));
    if (webRes.body) {
      Readable.fromWeb(webRes.body as never).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    console.error("api/[...all].ts handler error:", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    } else {
      res.end();
    }
  }
}
