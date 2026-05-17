import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, keccak256, pad, toHex, type Hex } from "viem";
import { createChainClient } from "../../src/chain/index.js";
import {
  AUTHORIZATION_USED_EVENT,
  BASE_SEPOLIA_USDC,
  USDC_TRANSFER_EVENT,
} from "../../src/chain/abi.js";

const PAYER = "0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895" as const;
const PAYEE = "0x1111111111111111111111111111111111111111" as const;
const OTHER_PAYEE = "0x2222222222222222222222222222222222222222" as const;
const NONCE: Hex = `0x${"f".repeat(64)}`;
const TX_HASH: Hex = `0x${"a".repeat(64)}`;
const BLOCK_HASH: Hex = `0x${"b".repeat(64)}`;
const OTHER_TOKEN = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as const;

interface MockRpc {
  blockNumber?: bigint;
  transaction?: unknown | null;
  receipt?: unknown | null;
  block?: unknown;
  /** Spy: records the methods called against this mock. */
  calls: string[];
}

/**
 * Build a minimal viem `custom`-style transport that intercepts JSON-RPC
 * calls and returns canned responses. Each test composes its own.
 */
function mockTransport(rpc: MockRpc) {
  return ({ retryCount: _ = 0 } = {}) => ({
    config: { key: "mock", name: "Mock", type: "mock" as const, retryCount: 0, timeout: 0 },
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      rpc.calls.push(method);
      switch (method) {
        case "eth_blockNumber":
          return toHex(rpc.blockNumber ?? 100n);
        case "eth_chainId":
          return toHex(84_532n); // Base Sepolia
        case "eth_getTransactionReceipt":
          if (rpc.receipt === undefined) {
            // viem treats null vs error differently — emulate "not yet mined" with null.
            return null;
          }
          return rpc.receipt;
        case "eth_getTransactionByHash":
          if (rpc.transaction === undefined) return null;
          return rpc.transaction;
        case "eth_getBlockByHash": {
          if (rpc.block === undefined) {
            throw new Error("eth_getBlockByHash: not stubbed");
          }
          return rpc.block;
        }
        case "eth_getLogs":
          return [];
        default:
          throw new Error(`mock transport: unhandled method ${method} ${JSON.stringify(params)}`);
      }
    },
    value: rpc,
  });
}

function transferLog(from: string, to: string, value: bigint, token: string = BASE_SEPOLIA_USDC) {
  const topics = encodeEventTopics({
    abi: [USDC_TRANSFER_EVENT],
    eventName: "Transfer",
    args: { from: from as `0x${string}`, to: to as `0x${string}` },
  }) as Hex[];
  const data = encodeAbiParameters([{ type: "uint256" }], [value]);
  return {
    address: token,
    topics,
    data,
    blockNumber: toHex(50n),
    transactionHash: TX_HASH,
    logIndex: toHex(0n),
    blockHash: BLOCK_HASH,
    transactionIndex: toHex(0n),
    removed: false,
  };
}

function authUsedLog(authorizer: string, nonce: Hex, token: string = BASE_SEPOLIA_USDC) {
  const topics = encodeEventTopics({
    abi: [AUTHORIZATION_USED_EVENT],
    eventName: "AuthorizationUsed",
    args: { authorizer: authorizer as `0x${string}`, nonce },
  }) as Hex[];
  return {
    address: token,
    topics,
    data: "0x",
    blockNumber: toHex(50n),
    transactionHash: TX_HASH,
    logIndex: toHex(1n),
    blockHash: BLOCK_HASH,
    transactionIndex: toHex(0n),
    removed: false,
  };
}

function successReceipt(logs: unknown[]) {
  return {
    transactionHash: TX_HASH,
    blockHash: BLOCK_HASH,
    blockNumber: toHex(50n),
    status: "0x1", // success
    gasUsed: toHex(100_000n),
    cumulativeGasUsed: toHex(100_000n),
    logs,
    type: "0x2",
    transactionIndex: toHex(0n),
    contractAddress: null,
    from: PAYER,
    to: BASE_SEPOLIA_USDC,
    logsBloom: pad("0x00", { size: 256 }),
    effectiveGasPrice: toHex(1n),
  };
}

function block() {
  return {
    number: toHex(50n),
    hash: BLOCK_HASH,
    timestamp: toHex(1_750_000_000n),
    nonce: pad("0x00", { size: 8 }),
    miner: PAYEE,
    parentHash: pad("0x00", { size: 32 }),
    sha3Uncles: pad("0x00", { size: 32 }),
    logsBloom: pad("0x00", { size: 256 }),
    stateRoot: pad("0x00", { size: 32 }),
    receiptsRoot: pad("0x00", { size: 32 }),
    transactionsRoot: pad("0x00", { size: 32 }),
    transactions: [],
    uncles: [],
    extraData: "0x",
    difficulty: toHex(0n),
    totalDifficulty: toHex(0n),
    gasLimit: toHex(30_000_000n),
    gasUsed: toHex(100_000n),
    size: toHex(1_000n),
    mixHash: pad("0x00", { size: 32 }),
    baseFeePerGas: toHex(1n),
  };
}

describe("createChainClient — verifyTransfer", () => {
  it("returns 'confirmed' with confirmations for a matching tx", async () => {
    const rpc: MockRpc = {
      blockNumber: 53n,
      receipt: successReceipt([transferLog(PAYER, PAYEE, 1_000n), authUsedLog(PAYER, NONCE)]),
      block: block(),
      calls: [],
    };
    const client = createChainClient({ retries: 0, transport: mockTransport(rpc) });
    const result = await client.verifyTransfer({
      txHash: TX_HASH,
      expectedFrom: PAYER,
      expectedTo: PAYEE,
      expectedAmount: 1_000n,
    });
    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    expect(result.confirmations).toBe(4n); // head 53 - block 50 + 1
    expect(result.transfer.from).toBe(PAYER);
    expect(result.transfer.to).toBe(PAYEE);
    expect(result.transfer.value).toBe(1_000n);
    expect(result.transfer.authorizationNonce).toBe(NONCE);
  });

  it("returns 'pending' for a tx with no receipt yet but in mempool", async () => {
    const rpc: MockRpc = {
      receipt: null,
      transaction: {
        hash: TX_HASH,
        blockNumber: null,
        blockHash: null,
        transactionIndex: null,
        from: PAYER,
        to: BASE_SEPOLIA_USDC,
        value: "0x0",
        gas: toHex(100_000n),
        gasPrice: toHex(1n),
        input: "0x",
        nonce: toHex(0n),
        r: pad("0x00", { size: 32 }),
        s: pad("0x00", { size: 32 }),
        v: toHex(0n),
        type: "0x2",
      },
      calls: [],
    };
    const client = createChainClient({ retries: 0, transport: mockTransport(rpc) });
    const result = await client.verifyTransfer({ txHash: TX_HASH });
    expect(result.kind).toBe("pending");
  });

  it("returns 'reverted' when receipt status is 0x0 but block is set on the tx", async () => {
    const revertedReceipt = {
      ...successReceipt([]),
      status: "0x0",
    };
    const rpc: MockRpc = {
      receipt: revertedReceipt,
      transaction: {
        hash: TX_HASH,
        blockNumber: toHex(50n),
        blockHash: BLOCK_HASH,
        transactionIndex: toHex(0n),
        from: PAYER,
        to: BASE_SEPOLIA_USDC,
        value: "0x0",
        gas: toHex(100_000n),
        gasPrice: toHex(1n),
        input: "0x",
        nonce: toHex(0n),
        r: pad("0x00", { size: 32 }),
        s: pad("0x00", { size: 32 }),
        v: toHex(0n),
        type: "0x2",
      },
      calls: [],
    };
    const client = createChainClient({ retries: 0, transport: mockTransport(rpc) });
    const result = await client.verifyTransfer({ txHash: TX_HASH });
    expect(result.kind).toBe("reverted");
  });

  it("returns 'not_found' when neither receipt nor tx exist", async () => {
    const rpc: MockRpc = { receipt: null, transaction: null, calls: [] };
    const client = createChainClient({ retries: 0, transport: mockTransport(rpc) });
    const result = await client.verifyTransfer({ txHash: TX_HASH });
    expect(result.kind).toBe("not_found");
  });

  it("returns 'wrong_recipient' when expectedTo doesn't match", async () => {
    const rpc: MockRpc = {
      receipt: successReceipt([transferLog(PAYER, PAYEE, 1_000n)]),
      block: block(),
      calls: [],
    };
    const client = createChainClient({ retries: 0, transport: mockTransport(rpc) });
    const result = await client.verifyTransfer({
      txHash: TX_HASH,
      expectedTo: OTHER_PAYEE,
      expectedAmount: 1_000n,
    });
    expect(result.kind).toBe("wrong_recipient");
    if (result.kind !== "wrong_recipient") return;
    expect(result.expectedTo).toBe(OTHER_PAYEE);
    expect(result.transfer.to).toBe(PAYEE);
  });

  it("returns 'wrong_amount' when amount doesn't match", async () => {
    const rpc: MockRpc = {
      receipt: successReceipt([transferLog(PAYER, PAYEE, 1_000n)]),
      block: block(),
      calls: [],
    };
    const client = createChainClient({ retries: 0, transport: mockTransport(rpc) });
    const result = await client.verifyTransfer({
      txHash: TX_HASH,
      expectedTo: PAYEE,
      expectedAmount: 5_000n,
    });
    expect(result.kind).toBe("wrong_amount");
    if (result.kind !== "wrong_amount") return;
    expect(result.expectedAmount).toBe(5_000n);
    expect(result.transfer.value).toBe(1_000n);
  });

  it("returns 'wrong_token' when Transfer is from a different contract", async () => {
    const rpc: MockRpc = {
      receipt: successReceipt([transferLog(PAYER, PAYEE, 1_000n, OTHER_TOKEN)]),
      block: block(),
      calls: [],
    };
    const client = createChainClient({ retries: 0, transport: mockTransport(rpc) });
    const result = await client.verifyTransfer({ txHash: TX_HASH });
    expect(result.kind).toBe("wrong_token");
    if (result.kind !== "wrong_token") return;
    expect(result.expectedToken).toBe(BASE_SEPOLIA_USDC);
    expect(result.actualToken.toLowerCase()).toBe(OTHER_TOKEN);
  });
});

describe("createChainClient — getTransferByTxHash", () => {
  it("returns a ChainTransfer with the AuthorizationUsed nonce when present", async () => {
    const rpc: MockRpc = {
      receipt: successReceipt([transferLog(PAYER, PAYEE, 1_000n), authUsedLog(PAYER, NONCE)]),
      block: block(),
      calls: [],
    };
    const client = createChainClient({ retries: 0, transport: mockTransport(rpc) });
    const transfer = await client.getTransferByTxHash(TX_HASH);
    expect(transfer).not.toBeNull();
    expect(transfer?.authorizationNonce).toBe(NONCE);
    expect(transfer?.value).toBe(1_000n);
    expect(transfer?.blockTimestamp).toBe(1_750_000_000);
  });

  it("returns null when the tx is not found", async () => {
    const rpc: MockRpc = { receipt: null, calls: [] };
    const client = createChainClient({ retries: 0, transport: mockTransport(rpc) });
    const transfer = await client.getTransferByTxHash(TX_HASH);
    expect(transfer).toBeNull();
  });

  it("returns null when the receipt has no Transfer log for the expected token", async () => {
    const rpc: MockRpc = {
      receipt: successReceipt([transferLog(PAYER, PAYEE, 1_000n, OTHER_TOKEN)]),
      block: block(),
      calls: [],
    };
    const client = createChainClient({ retries: 0, transport: mockTransport(rpc) });
    const transfer = await client.getTransferByTxHash(TX_HASH);
    expect(transfer).toBeNull();
  });

  // Sanity-check the placeholder reference to keccak256 (used elsewhere in
  // the codebase / future tests); keeps the import "used" without being
  // load-bearing for this file.
  it("import smoke check", () => {
    expect(typeof keccak256).toBe("function");
  });
});

// ─── X402-34: chain selection (Base mainnet support) ──────────────

describe("createChainClient — chain selection", () => {
  it("defaults to base-sepolia and uses the sepolia USDC contract in receipt fetches", async () => {
    const rpc: MockRpc = {
      receipt: successReceipt([transferLog(PAYER, PAYEE, 1_000n)]),
      block: block(),
      calls: [],
    };
    const client = createChainClient({ retries: 0, transport: mockTransport(rpc) });
    const transfer = await client.getTransferByTxHash(TX_HASH);
    expect(transfer?.tokenAddress.toLowerCase()).toBe(BASE_SEPOLIA_USDC.toLowerCase());
  });

  it("uses the mainnet USDC contract when chain=base (test transport provided)", async () => {
    const { BASE_USDC } = await import("../../src/chain/index.js");
    const rpc: MockRpc = {
      receipt: successReceipt([transferLog(PAYER, PAYEE, 1_000n, BASE_USDC)]),
      block: block(),
      calls: [],
    };
    const client = createChainClient({
      chain: "base",
      retries: 0,
      transport: mockTransport(rpc),
    });
    const transfer = await client.getTransferByTxHash(TX_HASH);
    expect(transfer?.tokenAddress.toLowerCase()).toBe(BASE_USDC.toLowerCase());
  });

  it("throws on construction when chain=base AND no rpcUrl AND no transport", () => {
    expect(() => createChainClient({ chain: "base" })).toThrow(/mainnet|RPC|hard rule/i);
  });

  it("does NOT throw when chain=base and rpcUrl is supplied (construction is lazy on RPC)", () => {
    expect(() =>
      createChainClient({ chain: "base", rpcUrl: "https://example-rpc.invalid" }),
    ).not.toThrow();
  });

  it("does NOT throw when chain=base and transport (test escape) is supplied", () => {
    const rpc: MockRpc = { receipt: null, calls: [] };
    expect(() => createChainClient({ chain: "base", transport: mockTransport(rpc) })).not.toThrow();
  });

  it("exposes usdcAddressFor() that routes to the canonical address per chain", async () => {
    const { usdcAddressFor, BASE_USDC } = await import("../../src/chain/index.js");
    expect(usdcAddressFor("base-sepolia")).toBe(BASE_SEPOLIA_USDC);
    expect(usdcAddressFor("base")).toBe(BASE_USDC);
  });
});
