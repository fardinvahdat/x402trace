import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { Hono } from "hono";

export interface ServerHandle {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export type RequestLogger = (event: {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Headers;
}) => void;

function toWebRequest(req: IncomingMessage, host: string): Request {
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

function collectRequestHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) out[k] = v.join(", ");
    else if (typeof v === "string") out[k] = v;
  }
  return out;
}

export async function startHonoServer(
  app: Hono,
  options: { port?: number; logger?: RequestLogger } = {},
): Promise<ServerHandle> {
  const server = createServer(async (req, res) => {
    const start = Date.now();
    const host = req.headers.host ?? `localhost:${(server.address() as AddressInfo)?.port ?? 0}`;
    try {
      const webReq = toWebRequest(req, host);
      const webRes = await app.fetch(webReq);
      const status = webRes.status;
      const responseHeaders = new Headers(webRes.headers);
      await writeWebResponse(webRes, res);
      options.logger?.({
        method: req.method ?? "GET",
        path: req.url ?? "/",
        status,
        durationMs: Date.now() - start,
        requestHeaders: collectRequestHeaders(req),
        responseHeaders,
      });
    } catch (err) {
      console.error("startHonoServer error:", err);
      if (!res.headersSent) res.statusCode = 500;
      res.end("Internal Server Error");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const port = address.port;
  const url = `http://localhost:${port}`;

  return {
    server,
    port,
    url,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
