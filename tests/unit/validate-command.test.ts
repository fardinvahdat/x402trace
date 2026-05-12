/**
 * X402-21 v0.2 — unit tests for `x402trace validate`.
 *
 * Mocks both the fetch (for the 402 challenge) and the chain client
 * (for USDC balance / nonce / wallet kind) so each scenario is
 * deterministic. Real chain coverage lives in the integration test
 * against the dogfood rig.
 */
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ChainClient } from "../../src/chain/index.js";
import {
  runValidateCommand,
  type ValidateCommandOptions,
  type ValidateRunContext,
} from "../../src/cli/validate-command.js";

const WALLET = "0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895" as const;
const PAYEE = "0x1111111111111111111111111111111111111111";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const SERVICE_URL = "http://example.test/api/weather";
const FIXED_NOW = new Date("2026-05-12T00:00:00Z");

// Captured shape for stdout/stderr so assertions can pattern-match
// the rendered output.
function capture() {
  let buf = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return {
    stream: stream as unknown as NodeJS.WritableStream,
    get output() {
      return buf;
    },
  };
}

function challengeBody(
  over: Partial<{ asset: string; payTo: string; maxAmountRequired: string; network: string }> = {},
) {
  return JSON.stringify({
    x402Version: 1,
    error: "X-PAYMENT header is required",
    accepts: [
      {
        scheme: "exact",
        network: over.network ?? "base-sepolia",
        maxAmountRequired: over.maxAmountRequired ?? "1000",
        resource: SERVICE_URL,
        payTo: over.payTo ?? PAYEE,
        maxTimeoutSeconds: 300,
        asset: over.asset ?? USDC,
        extra: { name: "USDC", version: "2" },
      },
    ],
  });
}

function mockFetch(opts: { status?: number; body?: string } = {}): typeof fetch {
  return (async () =>
    new Response(opts.body ?? challengeBody(), {
      status: opts.status ?? 402,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

function mockChain(over: Partial<ChainClient> = {}): ChainClient {
  return {
    async getUsdcBalance() {
      return 10_000n;
    },
    async isNonceConsumed() {
      return false;
    },
    async detectWalletKind() {
      return "eoa";
    },
    async getTransferByTxHash() {
      throw new Error("not used");
    },
    async verifyTransfer() {
      throw new Error("not used");
    },
    subscribeUsdcTransfers() {
      throw new Error("not used");
    },
    async getBlockNumber() {
      return 0n;
    },
    async close() {},
    ...over,
  } as ChainClient;
}

function makeCtx(over: Partial<ValidateRunContext> = {}): ValidateRunContext & {
  _out: ReturnType<typeof capture>;
  _err: ReturnType<typeof capture>;
} {
  const out = capture();
  const err = capture();
  return {
    stdout: out.stream,
    stderr: err.stream,
    env: {},
    fetch: mockFetch(),
    chainFactory: () => mockChain(),
    now: () => FIXED_NOW,
    _out: out,
    _err: err,
    ...over,
  };
}

describe("runValidateCommand — usage errors", () => {
  it("exits 1 when wallet is missing", async () => {
    const ctx = makeCtx();
    const code = await runValidateCommand({ service: SERVICE_URL }, ctx);
    expect(code).toBe(1);
    expect(ctx._err.output).toMatch(/wallet/i);
  });

  it("exits 1 when service is missing", async () => {
    const ctx = makeCtx();
    const code = await runValidateCommand({ wallet: WALLET }, ctx);
    expect(code).toBe(1);
  });

  it("exits 1 when wallet is not a valid address", async () => {
    const ctx = makeCtx();
    const code = await runValidateCommand({ wallet: "not-an-address", service: SERVICE_URL }, ctx);
    expect(code).toBe(1);
    expect(ctx._err.output).toMatch(/valid 0x-prefixed/);
  });

  it("exits 1 when service is not a valid URL", async () => {
    const ctx = makeCtx();
    const code = await runValidateCommand({ wallet: WALLET, service: "not a url" }, ctx);
    expect(code).toBe(1);
  });
});

describe("runValidateCommand — runtime", () => {
  const baseOpts: ValidateCommandOptions = {
    wallet: WALLET,
    service: SERVICE_URL,
  };

  it("exits 0 when chain + challenge all check out (would-succeed)", async () => {
    const ctx = makeCtx();
    const code = await runValidateCommand(baseOpts, ctx);
    expect(code).toBe(0);
    expect(ctx._out.output).toMatch(/would succeed/);
  });

  it("renders the wallet and service URL on the header line", async () => {
    const ctx = makeCtx();
    await runValidateCommand(baseOpts, ctx);
    expect(ctx._out.output).toContain(WALLET);
    expect(ctx._out.output).toContain(SERVICE_URL);
  });

  it("emits JSON output line-by-line when --log json is supplied", async () => {
    const ctx = makeCtx();
    await runValidateCommand({ ...baseOpts, log: "json" }, ctx);
    const lines = ctx._out.output.trim().split("\n");
    // Every line must round-trip through JSON.parse (the v0.1 contract
    // we lifted into format-result.test.ts).
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // The last line is the summary.
    const summary = JSON.parse(lines[lines.length - 1]!);
    expect(summary.event).toBe("diagnose.summary");
    expect(summary.overallStatus).toBe("would-succeed");
  });

  it("exits 2 (runtime) when balance is short — would-fail headline", async () => {
    const ctx = makeCtx({
      chainFactory: () =>
        mockChain({
          async getUsdcBalance() {
            return 10n; // not enough for maxAmountRequired=1000
          },
        }),
    });
    const code = await runValidateCommand(baseOpts, ctx);
    expect(code).toBe(2);
    expect(ctx._out.output).toMatch(/would fail/);
    expect(ctx._out.output).toMatch(/payer-balance/);
  });

  it("exits 2 when the nonce is already consumed", async () => {
    const ctx = makeCtx({
      chainFactory: () =>
        mockChain({
          async isNonceConsumed() {
            return true;
          },
        }),
    });
    const code = await runValidateCommand(baseOpts, ctx);
    expect(code).toBe(2);
    expect(ctx._out.output).toMatch(/nonce-fresh/);
  });

  it("warns and reports `uncertain` when chain queries fail entirely", async () => {
    const ctx = makeCtx({
      chainFactory: () =>
        mockChain({
          async getUsdcBalance() {
            throw new Error("RPC unreachable");
          },
        }),
    });
    const code = await runValidateCommand(baseOpts, ctx);
    expect(code).toBe(0); // uncertain exits 0 by default
    expect(ctx._err.output).toMatch(/chain state query failed/);
    expect(ctx._out.output).toMatch(/uncertain/);
  });

  it("with --strict, `uncertain` exits 2 instead of 0", async () => {
    const ctx = makeCtx({
      chainFactory: () =>
        mockChain({
          async getUsdcBalance() {
            throw new Error("RPC unreachable");
          },
        }),
    });
    const code = await runValidateCommand({ ...baseOpts, strict: true }, ctx);
    expect(code).toBe(2);
  });

  it("exits 2 when the service returns something other than 402", async () => {
    const ctx = makeCtx({ fetch: mockFetch({ status: 200, body: "{}" }) });
    const code = await runValidateCommand(baseOpts, ctx);
    expect(code).toBe(2);
    expect(ctx._err.output).toMatch(/expected/);
  });

  it("exits 2 when fetch itself throws (DNS failure, connection refused)", async () => {
    const ctx = makeCtx({
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    });
    const code = await runValidateCommand(baseOpts, ctx);
    expect(code).toBe(2);
    expect(ctx._err.output).toMatch(/failed to fetch/);
  });

  it("flags a non-canonical asset address (e.g. fake USDC contract)", async () => {
    const ctx = makeCtx({
      fetch: mockFetch({
        body: challengeBody({ asset: "0x9999999999999999999999999999999999999999" }),
      }),
    });
    const code = await runValidateCommand(baseOpts, ctx);
    expect(code).toBe(2);
    expect(ctx._out.output).toMatch(/asset-address/);
  });
});
