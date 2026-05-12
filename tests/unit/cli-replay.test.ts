import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chainTransferToJsonl, replayLog } from "../../src/cli/replay.js";
import type { ChainTransfer } from "../../src/chain/types.js";

const PAYER = "0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895" as const;
const PAYEE = "0x1111111111111111111111111111111111111111" as const;
const NONCE = `0x${"a".repeat(64)}` as const;
const TX = `0x${"b".repeat(64)}` as const;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "x402trace-cli-replay-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeJsonl(lines: Array<Record<string, unknown>>): Promise<string> {
  const path = join(dir, "log.jsonl");
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

const SAMPLE_TRANSFER: ChainTransfer = {
  txHash: TX,
  blockNumber: 42n,
  blockTimestamp: 1_700_000_001,
  from: PAYER,
  to: PAYEE,
  value: 1_000n,
  tokenAddress: USDC,
  authorizationNonce: NONCE,
};

function paymentLine(t: string) {
  return {
    event: "exchange.payment",
    t,
    id: "01HZX-replay",
    x402Version: 1,
    payment: {
      x402Version: 1,
      scheme: "exact",
      network: "base-sepolia",
      payload: {
        signature: "[REDACTED]",
        authorization: {
          from: PAYER,
          to: PAYEE,
          value: "1000",
          validAfter: "0",
          validBefore: "1750000000",
          nonce: NONCE,
        },
      },
    },
  };
}

function closedRejectedLine(t: string) {
  return {
    event: "exchange.closed",
    t,
    id: "01HZX-replay",
    response: {
      status: 402,
      headers: {},
      body: '{"error":"invalid_exact_evm_insufficient_balance"}',
    },
    outcome: {
      kind: "rejected",
      status: 402,
      receivedAt: t,
      rawBody: '{"error":"invalid_exact_evm_insufficient_balance"}',
    },
    durationMs: 12,
  };
}

describe("chainTransferToJsonl", () => {
  it("serialises bigints to strings and preserves the rest", () => {
    const obj = chainTransferToJsonl(SAMPLE_TRANSFER, "2026-05-12T00:00:00.000Z");
    expect(obj).toMatchObject({
      event: "chain.transfer",
      t: "2026-05-12T00:00:00.000Z",
      txHash: TX,
      blockNumber: "42",
      blockTimestamp: 1_700_000_001,
      value: "1000",
      authorizationNonce: NONCE,
    });
  });
});

describe("replayLog", () => {
  it("emits settled_on_chain when a chain.transfer matches a rejected exchange", async () => {
    const t0 = "2026-05-12T00:00:00.000Z";
    const t1 = "2026-05-12T00:00:01.000Z";
    const path = await writeJsonl([
      paymentLine(t0),
      closedRejectedLine(t0),
      chainTransferToJsonl(SAMPLE_TRANSFER, t1),
    ]);

    const report = await replayLog({ logPath: path });

    expect(report.counts.proxyClosed).toBe(1);
    expect(report.counts.decoderPayments).toBe(1);
    expect(report.counts.chainTransfers).toBe(1);
    expect(report.results).toHaveLength(1);
    const result = report.results[0]!;
    expect(result.kind).toBe("settled_on_chain");
    if (result.kind !== "settled_on_chain") return;
    expect(result.onChain.txHash).toBe(TX);
    expect(result.onChain.value).toBe(1_000n);
    expect(result.exchangeId).toBe("01HZX-replay");
  });

  it("emits not_settled when no matching chain.transfer arrives within the window", async () => {
    const t0 = "2026-05-12T00:00:00.000Z";
    const path = await writeJsonl([paymentLine(t0), closedRejectedLine(t0)]);

    const report = await replayLog({ logPath: path, watchTimeoutMs: 1_000 });

    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.kind).toBe("not_settled");
  });

  it("does NOT pend a paid exchange (success path: no reconciliation needed)", async () => {
    const t0 = "2026-05-12T00:00:00.000Z";
    const path = await writeJsonl([
      paymentLine(t0),
      {
        event: "exchange.closed",
        t: t0,
        id: "01HZX-replay",
        response: { status: 200, headers: {}, body: '{"ok":true}' },
        outcome: { kind: "paid", status: 200, receivedAt: t0 },
        durationMs: 7,
      },
      chainTransferToJsonl(SAMPLE_TRANSFER, "2026-05-12T00:00:01.000Z"),
    ]);

    const report = await replayLog({ logPath: path });
    expect(report.results).toHaveLength(0);
  });

  it("emits value_mismatch when the on-chain value differs", async () => {
    const t0 = "2026-05-12T00:00:00.000Z";
    const path = await writeJsonl([
      paymentLine(t0),
      closedRejectedLine(t0),
      chainTransferToJsonl({ ...SAMPLE_TRANSFER, value: 9_999n }, "2026-05-12T00:00:01.000Z"),
    ]);
    const report = await replayLog({ logPath: path });
    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.kind).toBe("value_mismatch");
  });

  it("counts malformed lines as skipped without crashing", async () => {
    const t0 = "2026-05-12T00:00:00.000Z";
    const path = await writeJsonl([
      paymentLine(t0),
      // malformed entry — missing closing brace would break JSON.parse,
      // but a plain non-event object is the more realistic case.
      { hello: "world" },
      closedRejectedLine(t0),
    ]);
    const report = await replayLog({ logPath: path });
    expect(report.counts.linesSkipped).toBeGreaterThanOrEqual(1);
    // The malformed line shouldn't affect the join — payment + closed
    // still produces a pending entry that eventually times out.
    expect(report.results.some((r) => r.kind === "not_settled")).toBe(true);
  });
});
