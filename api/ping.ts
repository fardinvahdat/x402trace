import type { IncomingMessage, ServerResponse } from "node:http";

// Bare-bones diagnostic endpoint. Zero imports beyond Node types. If
// /api/ping responds but /api/[...all] does not, the bug is in our Hono
// app or loadServerConfig, not in Vercel routing/runtime detection.
export default function handler(req: IncomingMessage, res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      ok: true,
      path: req.url,
      method: req.method,
      time: new Date().toISOString(),
      node: process.version,
      env: {
        hasReceiverAddress: Boolean(process.env.RECEIVER_ADDRESS),
        hasFacilitatorUrl: Boolean(process.env.FACILITATOR_URL),
      },
    }),
  );
}
