import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";
import { createSigner } from "x402/types";
import { createDogfoodApp } from "../../src/dogfood/app.js";
import { startHonoServer, type ServerHandle } from "../../src/dogfood/http-adapter.js";
import { createMockFacilitator, type MockFacilitator } from "../../src/dogfood/mock-facilitator.js";
import type { DogfoodConfig } from "../../src/dogfood/config.js";

// Canonical Anvil/Hardhat well-known test private key #0. Public, not a secret.
// Used here only to drive deterministic EIP-3009 signing — the mock facilitator
// returns canned success regardless of signature validity.
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const TEST_RECEIVER = "0x1111111111111111111111111111111111111111" as const;

let mock: MockFacilitator;
let mockServer: ServerHandle;
let dogfoodServer: ServerHandle;

beforeAll(async () => {
  mock = createMockFacilitator();
  mockServer = await startHonoServer(mock.app);

  const config: DogfoodConfig = {
    receiverAddress: TEST_RECEIVER,
    network: "base-sepolia",
    facilitatorUrl: mockServer.url,
    priceUsd: "$0.001",
    protectedPath: "/api/weather",
    description: "integration test",
  };
  dogfoodServer = await startHonoServer(createDogfoodApp(config));
});

afterAll(async () => {
  await dogfoodServer?.close();
  await mockServer?.close();
});

describe("dogfood paid flow (server + mock facilitator + client)", () => {
  it("returns 402 on the protected route when no X-PAYMENT header is sent", async () => {
    const res = await fetch(`${dogfoodServer.url}/api/weather`);
    expect(res.status).toBe(402);
    const body = (await res.json()) as { accepts: Array<{ network: string; payTo: string }> };
    expect(body.accepts[0]?.network).toBe("base-sepolia");
    expect(body.accepts[0]?.payTo).toBe(TEST_RECEIVER);
  });

  it("returns 200 with a settlement header when the client pays via x402-fetch", async () => {
    mock.reset();
    const signer = await createSigner("base-sepolia", TEST_PRIVATE_KEY);
    const fetchWithPay = wrapFetchWithPayment(fetch, signer);

    const res = await fetchWithPay(`${dogfoodServer.url}/api/weather`, { method: "GET" });
    expect(res.status).toBe(200);

    const settlementHeader = res.headers.get("x-payment-response");
    expect(settlementHeader, "expected X-PAYMENT-RESPONSE header on paid response").toBeTruthy();

    const decoded = decodeXPaymentResponse(settlementHeader!);
    expect(decoded.success).toBe(true);
    expect(decoded.network).toBe("base-sepolia");
    expect(decoded.transaction).toMatch(/^0x[0-9a-f]+$/i);

    const body = (await res.json()) as { endpoint: string; network: string };
    expect(body.endpoint).toBe("/api/weather");
    expect(body.network).toBe("base-sepolia");

    // The mock should have recorded exactly one settlement for this request.
    expect(mock.settlements.length).toBe(1);
    expect(mock.settlements[0]?.amount).toBe("1000"); // $0.001 USDC = 1000 base units
  });
});
