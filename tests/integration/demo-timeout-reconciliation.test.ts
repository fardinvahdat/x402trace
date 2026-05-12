/**
 * X402-15 hermetic reproduction of the timeout-reconciliation demo.
 *
 * The shell script in `examples/e2e-timeout-reconciliation.sh` runs
 * the same choreography against real Base Sepolia + the real
 * `x402.org/facilitator`. This test proves the choreography wiring
 * works without touching the chain:
 *
 *   1. dogfood server with `demoSleepMs=200` + `demoFailAfterSleep`,
 *      pointed at the mock facilitator (canned-success on /settle)
 *   2. proxy in front with `upstreamTimeoutMs=50` — guarantees the
 *      proxy gives up while the server is still sleeping
 *   3. dogfood client signs an EIP-3009 authorization, sends through
 *      the proxy, gets a 502 back
 *   4. test feeds a synthetic `ChainTransfer` carrying the same
 *      EIP-3009 nonce into the engine (simulating what the live
 *      chain client would do on real Base Sepolia)
 *   5. assert engine emits `settled_on_chain` for the proxy's
 *      `upstream_timeout` exchange
 *
 * This is the X402-15 smoke test of the demo's *programmatic* layers.
 * The actual on-chain settlement is exercised by running the shell
 * script manually — see [`examples/README.md`](../../examples/README.md).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { wrapFetchWithPayment } from "x402-fetch";
import { createSigner } from "x402/types";
import type { ChainTransfer } from "../../src/chain/types.js";
import { createDecoder } from "../../src/decoder/index.js";
import { createDogfoodApp } from "../../src/dogfood/app.js";
import { startHonoServer, type ServerHandle } from "../../src/dogfood/http-adapter.js";
import { createMockFacilitator, type MockFacilitator } from "../../src/dogfood/mock-facilitator.js";
import { createProxy, type ProxyHandle } from "../../src/proxy/index.js";
import { createReconciliationEngine } from "../../src/reconciliation/index.js";
import type { ReconciliationResult } from "../../src/reconciliation/types.js";

const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const TEST_RECEIVER = "0x1111111111111111111111111111111111111111" as const;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

let mock: MockFacilitator;
let mockServer: ServerHandle;
let dogfoodServer: ServerHandle;
let proxy: ProxyHandle;

beforeAll(async () => {
  // Mock facilitator returns canned success on /settle — in the real
  // demo this is what x402.org/facilitator does, which is *exactly*
  // why a wallet can be debited even when the server later fails.
  mock = createMockFacilitator();
  mockServer = await startHonoServer(mock.app);
  dogfoodServer = await startHonoServer(
    createDogfoodApp({
      receiverAddress: TEST_RECEIVER,
      network: "base-sepolia",
      facilitatorUrl: mockServer.url,
      priceUsd: "$0.001",
      protectedPath: "/api/weather",
      description: "X402-15 demo reproduction",
      // The demo knobs: sleep 200ms post-settle, then 500.
      demoSleepMs: 200,
      demoFailAfterSleep: true,
    }),
  );
  // 50ms upstream timeout — proxy gives up while the server is asleep.
  proxy = await createProxy({
    upstream: dogfoodServer.url,
    port: 0,
    upstreamTimeoutMs: 50,
  });
});

afterAll(async () => {
  await proxy?.close();
  await dogfoodServer?.close();
  await mockServer?.close();
});

describe("X402-15 demo reproduction (hermetic)", () => {
  it("emits settled_on_chain when the proxy times out post-settle and the chain catches up", async () => {
    const decoder = createDecoder({ logSecrets: true });
    const engine = createReconciliationEngine({ watchTimeoutMs: 10_000 });
    const results: ReconciliationResult[] = [];

    const proxySub = proxy.events.subscribe();
    const proxyTask = (async () => {
      for await (const event of proxySub) {
        engine.ingestProxyEvent(event);
        for (const decoded of decoder.decode(event)) {
          engine.ingestDecoderEvent(decoded);
        }
      }
    })();

    const resultsSub = engine.results();
    const resultsTask = (async () => {
      for await (const r of resultsSub) results.push(r);
    })();

    // Drive a paid request through the proxy. The 50ms upstream
    // timeout kicks in during the server's 200ms post-settle sleep,
    // so the client receives 502 — the canonical "I thought it
    // failed" signal.
    const signer = await createSigner("base-sepolia", TEST_PRIVATE_KEY);
    const fetchWithPay = wrapFetchWithPayment(fetch, signer);
    const res = await fetchWithPay(`${proxy.url}/api/weather`, { method: "GET" });
    expect(res.status).toBe(502); // proxy upstream timeout

    // Let event-bus drain. The engine should now have one pending
    // exchange (upstream_timeout outcome + payment payload).
    await new Promise((r) => setTimeout(r, 50));
    const pending = engine.pending();
    expect(pending).toHaveLength(1);
    const flagged = pending[0]!;
    expect(flagged.outcomeKind).toBe("upstream_timeout");

    // Now simulate what the live `subscribeUsdcTransfers` would emit
    // once Base Sepolia mines the matching Transfer event.
    const auth = flagged.payment.payload.authorization;
    const chainTransfer: ChainTransfer = {
      txHash: `0x${"d".repeat(64)}`,
      blockNumber: 12_345_678n,
      blockTimestamp: Math.floor(Date.now() / 1000),
      from: auth.from as `0x${string}`,
      to: auth.to as `0x${string}`,
      value: BigInt(auth.value),
      tokenAddress: USDC,
      authorizationNonce: auth.nonce as `0x${string}`,
    };
    engine.ingestChainTransfer(chainTransfer);

    // Drain the emitted result.
    await new Promise((r) => setTimeout(r, 50));
    proxySub.unsubscribe();
    resultsSub.unsubscribe();
    await engine.close();
    await proxyTask;
    await resultsTask;

    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.kind).toBe("settled_on_chain");
    if (result.kind !== "settled_on_chain") return;
    expect(result.exchangeId).toBe(flagged.id);
    expect(result.onChain.txHash).toBe(chainTransfer.txHash);
    expect(result.pending.outcomeKind).toBe("upstream_timeout");
  });
});
