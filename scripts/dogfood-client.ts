import "dotenv/config";
import { baseSepolia } from "viem/chains";
import { wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";
import { createSigner } from "x402/types";
import { loadClientConfig } from "../src/dogfood/config.js";

interface RunOptions {
  readonly path?: string;
}

export async function runDogfoodClient(opts: RunOptions = {}): Promise<void> {
  const config = loadClientConfig();
  // x402's createSigner builds a viem WalletClient with the right type shape
  // (extended with publicActions) for x402-fetch. It uses the chain's default
  // RPC — BASE_RPC_URL stays in env for the mainnet-guard check and for the
  // forthcoming proxy.
  const wallet = await createSigner("base-sepolia", config.payerPrivateKey);
  const path = opts.path ?? "/api/weather";
  const url = new URL(path, config.serverUrl).toString();

  const payerAddress = "account" in wallet ? wallet.account.address : wallet.address;
  console.log(`[client] target: ${url}`);
  console.log(`[client] payer:  ${payerAddress}`);
  console.log(`[client] chain:  ${baseSepolia.name} (${baseSepolia.id})`);

  // First, unpaid GET to capture the 402 challenge (this is what x402trace will need to parse).
  const unpaid = await fetch(url, { method: "GET" });
  console.log(`[client] unpaid GET -> ${unpaid.status}`);
  if (unpaid.status === 402) {
    const challenge = await unpaid
      .clone()
      .json()
      .catch(() => null);
    console.log("[client] 402 challenge body:", JSON.stringify(challenge));
  }

  // Now retry with x402-fetch, which signs and replays.
  const fetchWithPay = wrapFetchWithPayment(fetch, wallet);
  const paid = await fetchWithPay(url, { method: "GET" });
  console.log(`[client] paid GET   -> ${paid.status}`);
  const settlementHeader = paid.headers.get("x-payment-response");
  if (settlementHeader) {
    const decoded = decodeXPaymentResponse(settlementHeader);
    console.log("[client] settlement:", JSON.stringify(decoded));
  }
  const body = await paid.json();
  console.log("[client] response body:", JSON.stringify(body));

  if (paid.status !== 200) {
    throw new Error(`expected paid request to succeed, got ${paid.status}`);
  }
}

const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("dogfood-client.ts") === true;

if (isDirectRun) {
  runDogfoodClient().catch((err) => {
    console.error("[client] failed:", err);
    process.exit(1);
  });
}
