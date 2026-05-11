import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { paymentMiddleware } from "x402-hono";
import { wrapFetchWithPayment } from "x402-fetch";
import { createSigner } from "x402/types";
import { exact } from "x402/schemes";
import { createDogfoodApp } from "../../src/dogfood/app.js";
import {
  createMockFacilitator,
  type MockFacilitatorOptions,
} from "../../src/dogfood/mock-facilitator.js";
import { startHonoServer, type ServerHandle } from "../../src/dogfood/http-adapter.js";
import type { DogfoodConfig } from "../../src/dogfood/config.js";

// Well-known public Anvil/Hardhat test key #0. Public, not a secret —
// used only to drive deterministic signing in tests.
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const TEST_RECEIVER = "0x1111111111111111111111111111111111111111" as const;

interface Harness {
  readonly mockServer: ServerHandle;
  readonly dogfoodServer: ServerHandle;
  close(): Promise<void>;
}

async function startHarness(
  mockOpts: MockFacilitatorOptions,
  appBuilder: (facilitatorUrl: string) => Hono,
): Promise<Harness> {
  const mock = createMockFacilitator(mockOpts);
  const mockServer = await startHonoServer(mock.app);
  const dogfoodServer = await startHonoServer(appBuilder(mockServer.url));
  return {
    mockServer,
    dogfoodServer,
    async close() {
      await dogfoodServer.close();
      await mockServer.close();
    },
  };
}

function defaultAppBuilder(facilitatorUrl: string): Hono {
  const config: DogfoodConfig = {
    receiverAddress: TEST_RECEIVER,
    network: "base-sepolia",
    facilitatorUrl,
    priceUsd: "$0.001",
    protectedPath: "/api/weather",
    description: "failure-mode integration test",
  };
  return createDogfoodApp(config);
}

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) {
    await harness.close();
    harness = null;
  }
});

describe("dogfood failure modes (X402-4)", () => {
  it("#1 wrong chain ID: server rejects with 'Unable to find matching payment requirements'", async () => {
    // No mock-stubbed failure needed — the server rejects pre-facilitator.
    harness = await startHarness({}, defaultAppBuilder);
    const signer = await createSigner("base-sepolia", TEST_PRIVATE_KEY);
    const url = `${harness.dogfoodServer.url}/api/weather`;

    const unpaid = await fetch(url);
    expect(unpaid.status).toBe(402);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const challenge = (await unpaid.json()) as any;
    const requirements = challenge.accepts[0] as Parameters<typeof exact.evm.createPayment>[2];

    const evmSigner = signer as Parameters<typeof exact.evm.createPayment>[0];
    const payment = await exact.evm.createPayment(evmSigner, challenge.x402Version, requirements);
    const mutated = { ...payment, network: "avalanche-fuji" } as typeof payment;
    const header = exact.evm.encodePayment(mutated);

    const paid = await fetch(url, { method: "GET", headers: { "X-PAYMENT": header } });
    expect(paid.status).toBe(402);
    const body = (await paid.json()) as { error: string };
    expect(body.error).toBe("Unable to find matching payment requirements");
  });

  it("#2 expired validBefore: facilitator-returned 'invalid_exact_evm_payload_authorization_valid_before' surfaces in the server 402", async () => {
    harness = await startHarness(
      {
        verifyResponse: {
          isValid: false,
          invalidReason: "invalid_exact_evm_payload_authorization_valid_before",
        },
      },
      (facilitatorUrl) => {
        const app = new Hono();
        app.use(
          paymentMiddleware(
            TEST_RECEIVER,
            {
              "/api/weather": {
                price: "$0.001",
                network: "base-sepolia",
                config: { description: "test", maxTimeoutSeconds: -3600 },
              },
            },
            { url: facilitatorUrl as `${string}://${string}` },
          ),
        );
        app.get("/api/weather", (c) => c.json({ ok: true }));
        return app;
      },
    );

    const signer = await createSigner("base-sepolia", TEST_PRIVATE_KEY);
    const fetchWithPay = wrapFetchWithPayment(fetch, signer);
    const paid = await fetchWithPay(`${harness.dogfoodServer.url}/api/weather`, { method: "GET" });
    expect(paid.status).toBe(402);
    const body = (await paid.json()) as { error: string; payer: string };
    expect(body.error).toBe("invalid_exact_evm_payload_authorization_valid_before");
    expect(body.payer).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("#3 insufficient USDC: facilitator-returned 'invalid_exact_evm_insufficient_balance' surfaces in the server 402", async () => {
    harness = await startHarness(
      {
        verifyResponse: {
          isValid: false,
          invalidReason: "invalid_exact_evm_insufficient_balance",
        },
      },
      defaultAppBuilder,
    );
    const signer = await createSigner("base-sepolia", TEST_PRIVATE_KEY);
    const fetchWithPay = wrapFetchWithPayment(fetch, signer);
    const paid = await fetchWithPay(`${harness.dogfoodServer.url}/api/weather`, { method: "GET" });
    expect(paid.status).toBe(402);
    const body = (await paid.json()) as { error: string; payer: string };
    expect(body.error).toBe("invalid_exact_evm_insufficient_balance");
    expect(body.payer).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("#4 malformed signature: facilitator-returned 'invalid_exact_evm_signature' surfaces in the server 402", async () => {
    harness = await startHarness(
      { verifyResponse: { isValid: false, invalidReason: "invalid_exact_evm_signature" } },
      defaultAppBuilder,
    );

    const signer = await createSigner("base-sepolia", TEST_PRIVATE_KEY);
    const url = `${harness.dogfoodServer.url}/api/weather`;

    const unpaid = await fetch(url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const challenge = (await unpaid.json()) as any;
    const requirements = challenge.accepts[0] as Parameters<typeof exact.evm.createPayment>[2];
    const evmSigner = signer as Parameters<typeof exact.evm.createPayment>[0];
    const payment = await exact.evm.createPayment(evmSigner, challenge.x402Version, requirements);
    const evmPayload = payment.payload as { signature: `0x${string}`; authorization: unknown };

    // Flip last byte of signature
    const origSig = evmPayload.signature;
    const lastByte = origSig.slice(-2);
    const flipped = (parseInt(lastByte, 16) ^ 0xff).toString(16).padStart(2, "0");
    const badSig = origSig.slice(0, -2) + flipped;
    const badPayment = {
      ...payment,
      payload: { ...evmPayload, signature: badSig as `0x${string}` },
    } as typeof payment;
    const badHeader = exact.evm.encodePayment(badPayment);

    const paid = await fetch(url, { method: "GET", headers: { "X-PAYMENT": badHeader } });
    expect(paid.status).toBe(402);
    const body = (await paid.json()) as { error: string };
    expect(body.error).toBe("invalid_exact_evm_signature");
  });

  it("#5 facilitator unavailable: server returns 402 with 'fetch failed' when facilitator URL is unreachable", async () => {
    // Skip the mock entirely; point at a dead port. We still need to spin up
    // a dogfood server, just with a bad facilitator URL.
    const config: DogfoodConfig = {
      receiverAddress: TEST_RECEIVER,
      network: "base-sepolia",
      facilitatorUrl: "http://127.0.0.1:9",
      priceUsd: "$0.001",
      protectedPath: "/api/weather",
      description: "test",
    };
    const dogfoodServer = await startHonoServer(createDogfoodApp(config));
    try {
      const signer = await createSigner("base-sepolia", TEST_PRIVATE_KEY);
      const fetchWithPay = wrapFetchWithPayment(fetch, signer);
      const paid = await fetchWithPay(`${dogfoodServer.url}/api/weather`, { method: "GET" });
      expect(paid.status).toBe(402);
      const body = (await paid.json()) as { error: string };
      expect(body.error).toBe("fetch failed");
    } finally {
      await dogfoodServer.close();
    }
  });
});
