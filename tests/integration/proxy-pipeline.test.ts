import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { wrapFetchWithPayment } from "x402-fetch";
import { createSigner } from "x402/types";
import { createDogfoodApp } from "../../src/dogfood/app.js";
import { createMockFacilitator, type MockFacilitator } from "../../src/dogfood/mock-facilitator.js";
import { startHonoServer, type ServerHandle } from "../../src/dogfood/http-adapter.js";
import { createProxy, type ProxyHandle } from "../../src/proxy/index.js";

const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const TEST_RECEIVER = "0x1111111111111111111111111111111111111111" as const;

let mock: MockFacilitator;
let mockServer: ServerHandle;
let dogfoodServer: ServerHandle;
let proxy: ProxyHandle;
let logDir: string;
let logPath: string;

beforeAll(async () => {
  logDir = await mkdtemp(join(tmpdir(), "x402trace-proxy-pipeline-"));
  logPath = join(logDir, "events.jsonl");

  mock = createMockFacilitator();
  mockServer = await startHonoServer(mock.app);
  dogfoodServer = await startHonoServer(
    createDogfoodApp({
      receiverAddress: TEST_RECEIVER,
      network: "base-sepolia",
      facilitatorUrl: mockServer.url,
      priceUsd: "$0.001",
      protectedPath: "/api/weather",
      description: "X402-10 proxy pipeline test",
    }),
  );
  proxy = await createProxy({
    upstream: dogfoodServer.url,
    port: 0, // OS-assigned
    logPath,
  });
});

afterAll(async () => {
  await proxy?.close();
  await dogfoodServer?.close();
  await mockServer?.close();
  await rm(logDir, { recursive: true, force: true });
});

describe("proxy pipeline: client → proxy → dogfood-server with mock facilitator", () => {
  it("captures opened + closed events for a single unpaid GET that returns 402", async () => {
    const collected: unknown[] = [];
    const sub = proxy.events.subscribe();
    const collector = (async () => {
      for await (const event of sub) collected.push(event);
    })();

    const res = await fetch(`${proxy.url}/api/weather`);
    expect(res.status).toBe(402);
    await res.text();

    // Give the proxy a tick to emit the closing event.
    await new Promise((r) => setTimeout(r, 20));
    sub.unsubscribe();
    await collector;

    expect(collected.length).toBe(2);
    const opened = collected[0] as { event: string; id: string; request: { method: string } };
    const closed = collected[1] as {
      event: string;
      id: string;
      outcome: { kind: string; status: number };
      response: { status: number };
    };
    expect(opened.event).toBe("exchange.opened");
    expect(opened.request.method).toBe("GET");
    expect(closed.event).toBe("exchange.closed");
    expect(closed.id).toBe(opened.id);
    expect(closed.outcome.kind).toBe("rejected");
    expect(closed.outcome.status).toBe(402);
    expect(closed.response.status).toBe(402);
  });

  it("captures opened + closed events for a paid GET that returns 200", async () => {
    const collected: unknown[] = [];
    const sub = proxy.events.subscribe();
    const collector = (async () => {
      for await (const event of sub) collected.push(event);
    })();

    const signer = await createSigner("base-sepolia", TEST_PRIVATE_KEY);
    const fetchWithPay = wrapFetchWithPayment(fetch, signer);
    const res = await fetchWithPay(`${proxy.url}/api/weather`, { method: "GET" });
    expect(res.status).toBe(200);
    await res.text();

    await new Promise((r) => setTimeout(r, 20));
    sub.unsubscribe();
    await collector;

    // x402-fetch issues 2 requests through the proxy: unpaid (→402) then paid (→200).
    // So we expect 2 exchange.opened + 2 exchange.closed = 4 events.
    expect(collected.length).toBe(4);

    const closedEvents = collected.filter(
      (
        e,
      ): e is {
        event: "exchange.closed";
        outcome: { kind: string };
        response: { headers: Record<string, string> };
      } => (e as { event: string }).event === "exchange.closed",
    );
    expect(closedEvents).toHaveLength(2);
    expect(closedEvents[0]?.outcome.kind).toBe("rejected");
    expect(closedEvents[1]?.outcome.kind).toBe("paid");
    // The paid response carries the settlement header.
    expect(closedEvents[1]?.response.headers["x-payment-response"]).toBeTruthy();
  });

  it("persists captured events to the JSONL log file", async () => {
    // By this point both prior tests have run; the log should contain
    // all their events (append-only).
    const contents = await readFile(logPath, "utf8");
    const lines = contents.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(6); // 2 from first test + 4 from second

    // Every line is valid JSON with the expected discriminant.
    for (const line of lines) {
      const parsed = JSON.parse(line) as { event: string; t: string; id?: string };
      expect(["exchange.opened", "exchange.closed", "proxy.error"]).toContain(parsed.event);
      expect(parsed.t).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("emits proxy.error and returns 502 when upstream is unreachable", async () => {
    // Create a one-off proxy pointed at a guaranteed-dead port.
    const badProxy = await createProxy({
      upstream: "http://127.0.0.1:1",
      port: 0,
      upstreamTimeoutMs: 1_000,
    });

    const collected: unknown[] = [];
    const sub = badProxy.events.subscribe();
    const collector = (async () => {
      for await (const event of sub) collected.push(event);
    })();

    const res = await fetch(`${badProxy.url}/any/path`);
    expect(res.status).toBe(502);
    await res.text();

    await new Promise((r) => setTimeout(r, 20));
    sub.unsubscribe();
    await collector;
    await badProxy.close();

    const errorEvent = collected.find((e) => (e as { event: string }).event === "proxy.error");
    expect(errorEvent).toBeTruthy();
  });
});
