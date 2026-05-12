/**
 * X402-12 e2e test: verify chain client against live Base Sepolia using the
 * real settlement txs captured during X402-3.
 *
 * Skipped by default. Enable with `X402_E2E=1 pnpm test tests/e2e/chain-live.test.ts`.
 * Per TESTING.md, e2e tests run on push to v1/staging/main, not on every PR.
 */
import { describe, expect, it } from "vitest";
import { createChainClient } from "../../src/chain/index.js";

const RUN_E2E = process.env.X402_E2E === "1";
const describeE2E = RUN_E2E ? describe : describe.skip;

// The two settlement transactions from X402-3 (real on-chain transfers on Base Sepolia).
const SETTLEMENT_TX_1 =
  "0x8b53a04d71cd7dcc35fdf3682ae173758a76213db4ec1abae3e846b8c12b3428" as const;
const SETTLEMENT_TX_2 =
  "0xc5758bf2a0f8668a5613aae125a7ab529ef90ce96760020a1ff73309788c6cbf" as const;
const X402_3_WALLET = "0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895" as const;

describeE2E("chain client e2e — live Base Sepolia", () => {
  it("verifyTransfer returns 'confirmed' for the first X402-3 settlement", async () => {
    const client = createChainClient({});
    try {
      const result = await client.verifyTransfer({
        txHash: SETTLEMENT_TX_1,
        expectedFrom: X402_3_WALLET,
        expectedTo: X402_3_WALLET,
        expectedAmount: 1_000n,
      });
      expect(result.kind).toBe("confirmed");
      if (result.kind !== "confirmed") return;
      expect(result.transfer.value).toBe(1_000n);
      expect(result.transfer.from.toLowerCase()).toBe(X402_3_WALLET.toLowerCase());
      expect(result.transfer.to.toLowerCase()).toBe(X402_3_WALLET.toLowerCase());
      expect(result.transfer.authorizationNonce).toMatch(/^0x[0-9a-f]{64}$/i);
      expect(result.confirmations).toBeGreaterThan(0n);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("verifyTransfer returns 'confirmed' for the second X402-3 settlement", async () => {
    const client = createChainClient({});
    try {
      const result = await client.verifyTransfer({
        txHash: SETTLEMENT_TX_2,
        expectedAmount: 1_000n,
      });
      expect(result.kind).toBe("confirmed");
    } finally {
      await client.close();
    }
  }, 30_000);

  it("verifyTransfer returns 'wrong_amount' when expected amount doesn't match the real tx", async () => {
    const client = createChainClient({});
    try {
      const result = await client.verifyTransfer({
        txHash: SETTLEMENT_TX_1,
        expectedAmount: 9_999_999n,
      });
      expect(result.kind).toBe("wrong_amount");
      if (result.kind !== "wrong_amount") return;
      expect(result.transfer.value).toBe(1_000n);
      expect(result.expectedAmount).toBe(9_999_999n);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("verifyTransfer returns 'not_found' for a clearly bogus tx hash", async () => {
    const client = createChainClient({});
    try {
      const result = await client.verifyTransfer({
        txHash: `0x${"0".repeat(64)}` as const,
      });
      expect(result.kind).toBe("not_found");
    } finally {
      await client.close();
    }
  }, 30_000);
});
