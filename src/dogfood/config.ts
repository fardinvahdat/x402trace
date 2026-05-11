import type { Address } from "viem";
import type { Network } from "x402-hono";

export interface DogfoodConfig {
  readonly receiverAddress: Address;
  readonly network: Network;
  readonly facilitatorUrl: string;
  readonly priceUsd: `$${string}`;
  readonly protectedPath: string;
  readonly description: string;
}

export interface ClientConfig {
  readonly payerPrivateKey: `0x${string}`;
  readonly rpcUrl: string;
  readonly serverUrl: string;
}

const REQUIRED_TESTNET_NETWORK: Network = "base-sepolia";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function requireEnv(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new ConfigError(`Missing required env var: ${name}`);
  }
  return value.trim();
}

function assertAddress(name: string, value: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new ConfigError(`${name} is not a valid 0x-prefixed 20-byte address: ${value}`);
  }
  return value as Address;
}

function assertPrivateKey(name: string, value: string): `0x${string}` {
  const normalized = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new ConfigError(`${name} is not a valid 32-byte hex private key`);
  }
  return normalized as `0x${string}`;
}

function assertTestnetRpc(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} is not a valid URL: ${value}`);
  }
  const host = url.hostname.toLowerCase();
  // TESTNET ONLY (hard rule from CLAUDE.md). Reject hosts that match known Base mainnet RPCs.
  const mainnetHosts = ["mainnet.base.org", "base-mainnet.g.alchemy.com"];
  if (mainnetHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
    throw new ConfigError(
      `${name} points at Base mainnet (${host}). Testnet only until v0.1 ships.`,
    );
  }
  return value;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): DogfoodConfig {
  const receiver = assertAddress("RECEIVER_ADDRESS", requireEnv("RECEIVER_ADDRESS", env));
  const facilitatorUrl = requireEnv("FACILITATOR_URL", env);
  try {
    new URL(facilitatorUrl);
  } catch {
    throw new ConfigError(`FACILITATOR_URL is not a valid URL: ${facilitatorUrl}`);
  }
  return {
    receiverAddress: receiver,
    network: REQUIRED_TESTNET_NETWORK,
    facilitatorUrl,
    priceUsd: "$0.001",
    protectedPath: "/api/weather",
    description: "x402trace dogfood: Base Sepolia weather (testnet)",
  };
}

export function loadClientConfig(env: NodeJS.ProcessEnv = process.env): ClientConfig {
  const pk = assertPrivateKey("PAYER_PRIVATE_KEY", requireEnv("PAYER_PRIVATE_KEY", env));
  const rpcUrl = assertTestnetRpc("BASE_RPC_URL", requireEnv("BASE_RPC_URL", env));
  const serverUrl = requireEnv("DOGFOOD_SERVER_URL", env);
  try {
    new URL(serverUrl);
  } catch {
    throw new ConfigError(`DOGFOOD_SERVER_URL is not a valid URL: ${serverUrl}`);
  }
  return { payerPrivateKey: pk, rpcUrl, serverUrl };
}
