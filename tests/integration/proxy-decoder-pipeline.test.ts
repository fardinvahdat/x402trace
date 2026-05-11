import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { wrapFetchWithPayment } from "x402-fetch";
import { createSigner } from "x402/types";
import { createDogfoodApp } from "../../src/dogfood/app.js";
import { createMockFacilitator, type MockFacilitator } from "../../src/dogfood/mock-facilitator.js";
import { startHonoServer, type ServerHandle } from "../../src/dogfood/http-adapter.js";
import { createProxy, type ProxyHandle, type ProxyEvent } from "../../src/proxy/index.js";
import { createDecoder, type DecodedEvent, formatHuman } from "../../src/decoder/index.js";

const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const TEST_RECEIVER = "0x1111111111111111111111111111111111111111" as const;

let mock: MockFacilitator;
let mockServer: ServerHandle;
let dogfoodServer: ServerHandle;
let proxy: ProxyHandle;

beforeAll(async () => {
  mock = createMockFacilitator();
  mockServer = await startHonoServer(mock.app);
  dogfoodServer = await startHonoServer(
    createDogfoodApp({
      receiverAddress: TEST_RECEIVER,
      network: "base-sepolia",
      facilitatorUrl: mockServer.url,
      priceUsd: "$0.001",
      protectedPath: "/api/weather",
      description: "X402-11 decoder integration test",
    }),
  );
  proxy = await createProxy({ upstream: dogfoodServer.url, port: 0 });
});

afterAll(async () => {
  await proxy?.close();
  await dogfoodServer?.close();
  await mockServer?.close();
});

describe("proxy → decoder pipeline (X402-11)", () => {
  it("emits structured challenge + payment + settlement events for a paid flow", async () => {
    // Wire decoder onto the proxy bus.
    const decoder = createDecoder({ logSecrets: false });
    const proxyEvents: ProxyEvent[] = [];
    const decodedEvents: DecodedEvent[] = [];
    const sub = proxy.events.subscribe();
    const collector = (async () => {
      for await (const event of sub) {
        proxyEvents.push(event);
        for (const out of decoder.decode(event)) decodedEvents.push(out);
      }
    })();

    // Drive a paid GET through the proxy.
    const signer = await createSigner("base-sepolia", TEST_PRIVATE_KEY);
    const fetchWithPay = wrapFetchWithPayment(fetch, signer);
    const res = await fetchWithPay(`${proxy.url}/api/weather`, { method: "GET" });
    expect(res.status).toBe(200);
    await res.text();

    await new Promise((r) => setTimeout(r, 30));
    sub.unsubscribe();
    await collector;

    // Verify decoded events.
    const byKind = decodedEvents.reduce<Record<string, number>>((acc, e) => {
      acc[e.event] = (acc[e.event] ?? 0) + 1;
      return acc;
    }, {});
    expect(byKind["exchange.challenge"]).toBeGreaterThanOrEqual(1);
    expect(byKind["exchange.payment"]).toBeGreaterThanOrEqual(1);
    expect(byKind["exchange.settlement"]).toBeGreaterThanOrEqual(1);
    expect(byKind["decoder.error"]).toBeUndefined();
  });

  it("redacts payment signature by default", async () => {
    const decoder = createDecoder({ logSecrets: false });
    const decodedEvents: DecodedEvent[] = [];
    const sub = proxy.events.subscribe();
    const collector = (async () => {
      for await (const event of sub) {
        for (const out of decoder.decode(event)) decodedEvents.push(out);
      }
    })();

    const signer = await createSigner("base-sepolia", TEST_PRIVATE_KEY);
    const fetchWithPay = wrapFetchWithPayment(fetch, signer);
    await fetchWithPay(`${proxy.url}/api/weather`, { method: "GET" });

    await new Promise((r) => setTimeout(r, 30));
    sub.unsubscribe();
    await collector;

    const paymentEvent = decodedEvents.find((e) => e.event === "exchange.payment");
    expect(paymentEvent).toBeDefined();
    if (paymentEvent?.event !== "exchange.payment") throw new Error("expected payment event");
    expect(paymentEvent.payment.payload.signature).toBe("[REDACTED]");
    // Authorization fields remain intact (nonce is needed for reconciliation).
    expect(paymentEvent.payment.payload.authorization.nonce).toMatch(/^0x[0-9a-fA-F]+$/);
  });

  it("keeps payment signature when logSecrets=true", async () => {
    const decoder = createDecoder({ logSecrets: true });
    const decodedEvents: DecodedEvent[] = [];
    const sub = proxy.events.subscribe();
    const collector = (async () => {
      for await (const event of sub) {
        for (const out of decoder.decode(event)) decodedEvents.push(out);
      }
    })();

    const signer = await createSigner("base-sepolia", TEST_PRIVATE_KEY);
    const fetchWithPay = wrapFetchWithPayment(fetch, signer);
    await fetchWithPay(`${proxy.url}/api/weather`, { method: "GET" });

    await new Promise((r) => setTimeout(r, 30));
    sub.unsubscribe();
    await collector;

    const paymentEvent = decodedEvents.find((e) => e.event === "exchange.payment");
    if (paymentEvent?.event !== "exchange.payment") throw new Error("expected payment event");
    expect(paymentEvent.payment.payload.signature).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(paymentEvent.payment.payload.signature).not.toBe("[REDACTED]");
  });

  it("formats decoded events into readable human output", async () => {
    const decoder = createDecoder({ logSecrets: false });
    const sub = proxy.events.subscribe();
    const decodedLines: string[] = [];
    const collector = (async () => {
      for await (const event of sub) {
        for (const out of decoder.decode(event)) decodedLines.push(formatHuman(out));
      }
    })();

    const signer = await createSigner("base-sepolia", TEST_PRIVATE_KEY);
    const fetchWithPay = wrapFetchWithPayment(fetch, signer);
    await fetchWithPay(`${proxy.url}/api/weather`, { method: "GET" });

    await new Promise((r) => setTimeout(r, 30));
    sub.unsubscribe();
    await collector;

    expect(decodedLines.some((l) => l.includes("402 challenge"))).toBe(true);
    expect(decodedLines.some((l) => l.includes("X-PAYMENT"))).toBe(true);
    expect(decodedLines.some((l) => l.includes("✓ success"))).toBe(true);
  });
});
