import { describe, expect, it } from "vitest";
import { ConfigError, loadClientConfig, loadServerConfig } from "../../src/dogfood/config.js";

const VALID_RECEIVER = "0x1111111111111111111111111111111111111111";
const VALID_PRIVATE_KEY = "0x" + "a".repeat(64);
const VALID_RPC = "https://sepolia.base.org";
const VALID_SERVER = "http://localhost:3402";
const VALID_FACILITATOR = "https://x402.org/facilitator";

function serverEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    RECEIVER_ADDRESS: VALID_RECEIVER,
    FACILITATOR_URL: VALID_FACILITATOR,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function clientEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    PAYER_PRIVATE_KEY: VALID_PRIVATE_KEY,
    BASE_RPC_URL: VALID_RPC,
    DOGFOOD_SERVER_URL: VALID_SERVER,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("loadServerConfig", () => {
  it("loads a complete, well-formed config from env", () => {
    const config = loadServerConfig(serverEnv());
    expect(config.receiverAddress).toBe(VALID_RECEIVER);
    expect(config.network).toBe("base-sepolia");
    expect(config.facilitatorUrl).toBe(VALID_FACILITATOR);
    expect(config.priceUsd).toBe("$0.001");
    expect(config.protectedPath).toBe("/api/weather");
  });

  it("rejects a missing RECEIVER_ADDRESS", () => {
    expect(() => loadServerConfig(serverEnv({ RECEIVER_ADDRESS: undefined }))).toThrow(ConfigError);
  });

  it("rejects an empty RECEIVER_ADDRESS", () => {
    expect(() => loadServerConfig(serverEnv({ RECEIVER_ADDRESS: "   " }))).toThrow(/Missing/);
  });

  it("rejects a malformed RECEIVER_ADDRESS", () => {
    expect(() => loadServerConfig(serverEnv({ RECEIVER_ADDRESS: "0xnotanaddress" }))).toThrow(
      /not a valid 0x-prefixed 20-byte address/,
    );
  });

  it("rejects a missing FACILITATOR_URL", () => {
    expect(() => loadServerConfig(serverEnv({ FACILITATOR_URL: undefined }))).toThrow(ConfigError);
  });

  it("rejects a malformed FACILITATOR_URL", () => {
    expect(() => loadServerConfig(serverEnv({ FACILITATOR_URL: "not a url" }))).toThrow(
      /not a valid URL/,
    );
  });

  it("pins the network to base-sepolia (testnet-only hard rule)", () => {
    // Even if env tries to override, server config only exposes base-sepolia.
    const config = loadServerConfig(serverEnv({ NETWORK: "base" }));
    expect(config.network).toBe("base-sepolia");
  });
});

describe("loadClientConfig", () => {
  it("loads a complete, well-formed config from env", () => {
    const config = loadClientConfig(clientEnv());
    expect(config.payerPrivateKey).toBe(VALID_PRIVATE_KEY);
    expect(config.rpcUrl).toBe(VALID_RPC);
    expect(config.serverUrl).toBe(VALID_SERVER);
  });

  it("normalizes a private key without 0x prefix", () => {
    const stripped = VALID_PRIVATE_KEY.slice(2);
    const config = loadClientConfig(clientEnv({ PAYER_PRIVATE_KEY: stripped }));
    expect(config.payerPrivateKey).toBe(VALID_PRIVATE_KEY);
  });

  it("rejects a private key that is not 32 bytes", () => {
    expect(() => loadClientConfig(clientEnv({ PAYER_PRIVATE_KEY: "0xdeadbeef" }))).toThrow(
      /not a valid 32-byte hex private key/,
    );
  });

  it("rejects a private key with non-hex characters", () => {
    const bad = "0x" + "z".repeat(64);
    expect(() => loadClientConfig(clientEnv({ PAYER_PRIVATE_KEY: bad }))).toThrow(
      /not a valid 32-byte hex private key/,
    );
  });

  it("rejects Base mainnet RPC URLs (TESTNET ONLY hard rule)", () => {
    expect(() => loadClientConfig(clientEnv({ BASE_RPC_URL: "https://mainnet.base.org" }))).toThrow(
      /Base mainnet/,
    );
  });

  it("rejects mainnet RPCs from third-party providers (host suffix match)", () => {
    expect(() =>
      loadClientConfig(
        clientEnv({ BASE_RPC_URL: "https://api.base-mainnet.g.alchemy.com/v2/abc" }),
      ),
    ).toThrow(/Base mainnet/);
  });

  it("rejects a malformed BASE_RPC_URL", () => {
    expect(() => loadClientConfig(clientEnv({ BASE_RPC_URL: "not a url" }))).toThrow(
      /not a valid URL/,
    );
  });

  it("rejects a missing DOGFOOD_SERVER_URL", () => {
    expect(() => loadClientConfig(clientEnv({ DOGFOOD_SERVER_URL: undefined }))).toThrow(
      /Missing required env var: DOGFOOD_SERVER_URL/,
    );
  });

  it("rejects a malformed DOGFOOD_SERVER_URL", () => {
    expect(() => loadClientConfig(clientEnv({ DOGFOOD_SERVER_URL: "not a url" }))).toThrow(
      /not a valid URL/,
    );
  });
});
