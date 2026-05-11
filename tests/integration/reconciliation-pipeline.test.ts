/**
 * X402-13 integration test — reproduces the canonical [#1062](https://github.com/coinbase/x402/issues/1062)
 * scenario per the ticket acceptance criterion:
 *
 *   "Reproduces Issue #1062 scenario in a test: mocked facilitator timeout
 *    + real Base Sepolia tx → reconciliation reports `settled`."
 *
 * We use the mock facilitator from X402-3 to force a verify-side rejection
 * (the symptom: facilitator says "no, it didn't go through"), then
 * synthesise a matching `ChainTransfer` for the same EIP-3009 nonce (the
 * truth: the on-chain tx actually settled). The engine wires the proxy +
 * decoder events together and emits `settled_on_chain` — the
 * "wallet was debited but facilitator did not confirm" detection.
 *
 * A real Base Sepolia tx is not used here for hermeticity reasons (CI
 * doesn't burn faucet funds); the e2e validation against actual settlement
 * txs lives in tests/e2e/.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { wrapFetchWithPayment } from "x402-fetch";
import { createSigner } from "x402/types";
import { createDogfoodApp } from "../../src/dogfood/app.js";
import { createMockFacilitator, type MockFacilitator } from "../../src/dogfood/mock-facilitator.js";
import { startHonoServer, type ServerHandle } from "../../src/dogfood/http-adapter.js";
import { createProxy, type ProxyHandle } from "../../src/proxy/index.js";
import { createDecoder } from "../../src/decoder/index.js";
import { createReconciliationEngine } from "../../src/reconciliation/index.js";
import type { ChainTransfer } from "../../src/chain/types.js";
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
  // Configure the mock facilitator to REJECT verify — this simulates the
  // canonical #1062 symptom (facilitator returns failure, but in real
  // production the on-chain transferWithAuthorization may have already
  // landed).
  mock = createMockFacilitator({
    verifyResponse: {
      isValid: false,
      invalidReason: "invalid_exact_evm_insufficient_balance",
    },
  });
  mockServer = await startHonoServer(mock.app);
  dogfoodServer = await startHonoServer(
    createDogfoodApp({
      receiverAddress: TEST_RECEIVER,
      network: "base-sepolia",
      facilitatorUrl: mockServer.url,
      priceUsd: "$0.001",
      protectedPath: "/api/weather",
      description: "X402-13 reconciliation pipeline test",
    }),
  );
  proxy = await createProxy({ upstream: dogfoodServer.url, port: 0 });
});

afterAll(async () => {
  await proxy?.close();
  await dogfoodServer?.close();
  await mockServer?.close();
});

describe("reconciliation pipeline (X402-13) — canonical #1062 scenario", () => {
  it("emits `settled_on_chain` when a matching ChainTransfer arrives for a facilitator-rejected payment", async () => {
    const decoder = createDecoder({ logSecrets: true });
    // logSecrets=true so we keep the real signature; the engine doesn't
    // care, but `payment.payload.authorization.nonce` MUST round-trip
    // intact — that's the match key.
    const engine = createReconciliationEngine({ watchTimeoutMs: 30_000 });
    const results: ReconciliationResult[] = [];

    // Wire proxy events into both decoder and engine.
    const sub = proxy.events.subscribe();
    const collector = (async () => {
      for await (const event of sub) {
        engine.ingestProxyEvent(event);
        for (const decoded of decoder.decode(event)) {
          engine.ingestDecoderEvent(decoded);
        }
      }
    })();

    // Wire engine results into a local sink.
    const resultsSub = engine.results();
    const resultsCollector = (async () => {
      for await (const r of resultsSub) results.push(r);
    })();

    // Drive a paid request through the proxy. The mock facilitator will
    // reject /verify, so the server returns 402 with the "rejected"
    // outcome. The proxy + decoder + engine should flag this exchange
    // as pending reconciliation.
    const signer = await createSigner("base-sepolia", TEST_PRIVATE_KEY);
    const fetchWithPay = wrapFetchWithPayment(fetch, signer);
    const paid = await fetchWithPay(`${proxy.url}/api/weather`, { method: "GET" });
    expect(paid.status).toBe(402); // facilitator rejected

    // Give the event-bus a tick to drain.
    await new Promise((r) => setTimeout(r, 50));

    const pending = engine.pending();
    expect(pending).toHaveLength(1);
    const flagged = pending[0]!;
    expect(flagged.outcomeKind).toBe("rejected");
    expect(flagged.errorReason).toBe("invalid_exact_evm_insufficient_balance");

    // Synthesise the on-chain settlement that "really happened":
    // same payer, same payee, same value, same EIP-3009 nonce.
    const auth = flagged.payment.payload.authorization;
    const chainTransfer: ChainTransfer = {
      txHash: `0x${"f".repeat(64)}`,
      blockNumber: 12_345_678n,
      blockTimestamp: Math.floor(Date.now() / 1000),
      from: auth.from as `0x${string}`,
      to: auth.to as `0x${string}`,
      value: BigInt(auth.value),
      tokenAddress: USDC,
      authorizationNonce: auth.nonce as `0x${string}`,
    };
    engine.ingestChainTransfer(chainTransfer);

    // Drain the result.
    await new Promise((r) => setTimeout(r, 50));
    sub.unsubscribe();
    resultsSub.unsubscribe();
    await collector;
    await resultsCollector;
    await engine.close();

    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.kind).toBe("settled_on_chain");
    if (result.kind !== "settled_on_chain") return;
    expect(result.exchangeId).toBe(flagged.id);
    expect(result.onChain.txHash).toBe(chainTransfer.txHash);
    expect(result.pending.errorReason).toBe("invalid_exact_evm_insufficient_balance");
    expect(engine.pending()).toHaveLength(0);
  });

  it("reports `not_settled` when the facilitator-rejection has no matching on-chain transfer within the window", async () => {
    const decoder = createDecoder({ logSecrets: true });
    const engine = createReconciliationEngine({
      watchTimeoutMs: 100, // short window
      sweepIntervalMs: 25,
    });
    const results: ReconciliationResult[] = [];

    const sub = proxy.events.subscribe();
    const collector = (async () => {
      for await (const event of sub) {
        engine.ingestProxyEvent(event);
        for (const decoded of decoder.decode(event)) {
          engine.ingestDecoderEvent(decoded);
        }
      }
    })();
    const resultsSub = engine.results();
    const resultsCollector = (async () => {
      for await (const r of resultsSub) results.push(r);
    })();

    const signer = await createSigner("base-sepolia", TEST_PRIVATE_KEY);
    const fetchWithPay = wrapFetchWithPayment(fetch, signer);
    await fetchWithPay(`${proxy.url}/api/weather`, { method: "GET" });

    // Don't feed any ChainTransfer. Wait past the watch window.
    await new Promise((r) => setTimeout(r, 300));

    sub.unsubscribe();
    resultsSub.unsubscribe();
    await collector;
    await resultsCollector;
    await engine.close();

    expect(results.length).toBeGreaterThanOrEqual(1);
    const notSettled = results.find((r) => r.kind === "not_settled");
    expect(notSettled).toBeDefined();
  });
});
