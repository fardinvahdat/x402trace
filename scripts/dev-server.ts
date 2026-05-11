import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { Hono } from "hono";
import { createDogfoodApp } from "../src/dogfood/app.js";
import { loadServerConfig } from "../src/dogfood/config.js";

const PORT = Number(process.env.DOGFOOD_PORT ?? 3402);

function toWebRequest(req: IncomingMessage, port: number): Request {
  const host = req.headers.host ?? `localhost:${port}`;
  const url = `http://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) headers.set(name, value.join(", "));
    else if (typeof value === "string") headers.set(name, value);
  }
  const init: RequestInit & { duplex?: "half" } = { method: req.method ?? "GET", headers };
  if (req.method && req.method !== "GET" && req.method !== "HEAD") {
    init.body = Readable.toWeb(req) as unknown as ReadableStream;
    init.duplex = "half";
  }
  return new Request(url, init);
}

async function writeWebResponse(webRes: Response, nodeRes: ServerResponse): Promise<void> {
  nodeRes.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => nodeRes.setHeader(key, value));
  if (webRes.body) {
    Readable.fromWeb(webRes.body as never).pipe(nodeRes);
  } else {
    nodeRes.end();
  }
}

function logExchange(
  req: IncomingMessage,
  status: number,
  durationMs: number,
  headers: Headers,
): void {
  const ts = new Date().toISOString();
  const accept = req.headers.accept ?? "-";
  const xPay = req.headers["x-payment"] ? "x-payment:present" : "x-payment:none";
  const xPayResp = headers.get("x-payment-response") ? "x-payment-response:present" : "";
  const tail = [xPay, xPayResp].filter(Boolean).join(" ");
  console.log(
    `[${ts}] ${req.method} ${req.url} -> ${status} ${durationMs}ms accept=${accept} ${tail}`,
  );
}

function buildAdapter(app: Hono, port: number) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const start = Date.now();
    try {
      const webReq = toWebRequest(req, port);
      const webRes = await app.fetch(webReq);
      const clone = webRes.clone();
      await writeWebResponse(webRes, res);
      logExchange(req, clone.status, Date.now() - start, clone.headers);
    } catch (err) {
      console.error("dev-server error:", err);
      if (!res.headersSent) res.statusCode = 500;
      res.end("Internal Server Error");
    }
  };
}

async function main(): Promise<void> {
  const config = loadServerConfig();
  const app = createDogfoodApp(config);
  const server = createServer(buildAdapter(app, PORT));
  await new Promise<void>((resolve) => server.listen(PORT, () => resolve()));
  console.log(`x402trace dogfood server listening on http://localhost:${PORT}`);
  console.log(`  receiver:    ${config.receiverAddress}`);
  console.log(`  network:     ${config.network}`);
  console.log(`  facilitator: ${config.facilitatorUrl}`);
  console.log(`  protected:   GET ${config.protectedPath} @ ${config.priceUsd}`);
  console.log(`  unpaid GET:  curl -i http://localhost:${PORT}${config.protectedPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
