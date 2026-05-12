import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { newExchangeId } from "./id.js";
import { createEventBus, type EventBus } from "./event-bus.js";
import { JsonlSink } from "./jsonl-sink.js";
import type { CapturedRequest, CapturedResponse, ExchangeOutcome, ProxyEvent } from "./types.js";

export interface ProxyOptions {
  /** Base URL of the upstream service (e.g. `https://api.example.com`). */
  readonly upstream: string;
  /** Listen port. 0 = OS-assigned (used by tests). Default 8402. */
  readonly port?: number;
  /** Path to the JSONL log file. If undefined, no file is written. */
  readonly logPath?: string;
  /** Per-request upstream timeout. Default 30_000 ms. */
  readonly upstreamTimeoutMs?: number;
}

export interface ProxyHandle {
  readonly server: Server;
  readonly url: string;
  readonly events: EventBus<ProxyEvent>;
  readonly logPath: string | null;
  close(): Promise<void>;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host", // we rewrite Host to match the upstream
]);

function isLikelyTextContentType(contentType: string | undefined): boolean {
  if (!contentType) return true; // empty body = treat as text
  const lower = contentType.toLowerCase();
  return (
    lower.startsWith("text/") ||
    lower.includes("application/json") ||
    lower.includes("application/x-www-form-urlencoded") ||
    lower.includes("+json") ||
    lower.includes("+xml") ||
    lower.startsWith("application/xml")
  );
}

function isValidUtf8(buf: Buffer): boolean {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    decoder.decode(buf);
    return true;
  } catch {
    return false;
  }
}

function bodyToCapture(
  body: Buffer,
  contentType: string | undefined,
): {
  body?: string;
  bodyBase64?: string;
} {
  if (body.length === 0) return { body: "" };
  if (isLikelyTextContentType(contentType) && isValidUtf8(body)) {
    return { body: body.toString("utf8") };
  }
  return { bodyBase64: body.toString("base64") };
}

function collectHeaders(raw: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (Array.isArray(value)) out[name] = value.join(", ");
    else if (typeof value === "string") out[name] = value;
  }
  return out;
}

async function readNodeBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function classifyOutcome(
  res: CapturedResponse,
  receivedAt: string,
): Extract<ExchangeOutcome, { kind: "paid" | "rejected" | "unknown" }> {
  if (res.status >= 200 && res.status < 300) {
    const header = res.headers["x-payment-response"] ?? res.headers["payment-response"];
    return {
      kind: "paid",
      status: res.status,
      receivedAt,
      ...(header ? { rawPaymentResponseHeader: header } : {}),
    };
  }
  if (res.status === 402) {
    return {
      kind: "rejected",
      status: res.status,
      receivedAt,
      ...(res.body !== undefined ? { rawBody: res.body } : {}),
    };
  }
  return { kind: "unknown", status: res.status, receivedAt };
}

function stripHopByHop(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

export async function createProxy(opts: ProxyOptions): Promise<ProxyHandle> {
  const upstream = new URL(opts.upstream);
  const upstreamTimeoutMs = opts.upstreamTimeoutMs ?? 30_000;
  const events = createEventBus<ProxyEvent>();

  let sink: JsonlSink | null = null;
  if (opts.logPath) {
    sink = new JsonlSink(opts.logPath);
    await sink.open();
  }

  const emit = (event: ProxyEvent): void => {
    events.emit(event);
    sink?.append(event);
  };

  const server = createServer(async (req, res) => {
    const id = newExchangeId();
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();

    let capturedReq: CapturedRequest | null = null;
    try {
      const reqHeaders = collectHeaders(req.headers);
      const reqBodyBuf = await readNodeBody(req);
      const reqContentType = reqHeaders["content-type"];
      capturedReq = {
        method: (req.method ?? "GET").toUpperCase(),
        path: req.url ?? "/",
        headers: reqHeaders,
        ...bodyToCapture(reqBodyBuf, reqContentType),
      };

      emit({
        event: "exchange.opened",
        t: startedAtIso,
        id,
        upstreamUrl: opts.upstream,
        request: capturedReq,
      });

      // Build upstream URL by appending the client's path to the upstream base.
      const upstreamUrl = new URL(
        capturedReq.path.replace(/^\/+/, ""),
        upstream.origin + upstream.pathname.replace(/\/?$/, "/"),
      );

      // Forward request to upstream.
      const fwdHeaders = stripHopByHop(capturedReq.headers);
      const init: RequestInit = {
        method: capturedReq.method,
        headers: fwdHeaders,
        signal: AbortSignal.timeout(upstreamTimeoutMs),
      };
      if (capturedReq.method !== "GET" && capturedReq.method !== "HEAD" && reqBodyBuf.length > 0) {
        init.body = reqBodyBuf;
      }

      let upstreamResp: Response;
      try {
        upstreamResp = await fetch(upstreamUrl.toString(), init);
      } catch (err) {
        const isTimeout = err instanceof Error && err.name === "TimeoutError";
        const receivedAt = new Date().toISOString();
        const durationMs = Date.now() - startedAt;
        const outcome: ExchangeOutcome = isTimeout
          ? { kind: "upstream_timeout", afterMs: durationMs, observedAt: receivedAt }
          : { kind: "unknown", status: 0, receivedAt };

        emit({
          event: "exchange.closed",
          t: receivedAt,
          id,
          response: { status: 502, headers: { "content-type": "text/plain" }, body: "Bad Gateway" },
          outcome,
          durationMs,
        });
        emit({
          event: "proxy.error",
          t: receivedAt,
          id,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        res.statusCode = 502;
        res.setHeader("content-type", "text/plain");
        res.end("Bad Gateway");
        return;
      }

      // Read upstream response.
      const respHeaders: Record<string, string> = {};
      upstreamResp.headers.forEach((value, key) => {
        respHeaders[key.toLowerCase()] = value;
      });
      const respBodyBuf = Buffer.from(await upstreamResp.arrayBuffer());
      const respContentType = respHeaders["content-type"];
      const capturedRes: CapturedResponse = {
        status: upstreamResp.status,
        headers: respHeaders,
        ...bodyToCapture(respBodyBuf, respContentType),
      };

      const receivedAt = new Date().toISOString();
      const durationMs = Date.now() - startedAt;
      const outcome = classifyOutcome(capturedRes, receivedAt);

      emit({
        event: "exchange.closed",
        t: receivedAt,
        id,
        response: capturedRes,
        outcome,
        durationMs,
      });

      // Forward back to client.
      res.statusCode = capturedRes.status;
      for (const [name, value] of Object.entries(stripHopByHop(respHeaders))) {
        res.setHeader(name, value);
      }
      res.end(respBodyBuf);
    } catch (err) {
      const t = new Date().toISOString();
      emit({
        event: "proxy.error",
        t,
        id,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "text/plain");
        res.end("Proxy Error");
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 8402, () => {
      server.off("error", reject);
      resolveListen();
    });
  });

  const address = server.address() as AddressInfo;
  const url = `http://localhost:${address.port}`;

  return {
    server,
    url,
    events,
    logPath: sink?.filePath ?? null,
    async close() {
      await new Promise<void>((resolveClose, reject) => {
        server.close((err) => (err ? reject(err) : resolveClose()));
      });
      await sink?.close();
    },
  };
}
