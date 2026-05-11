/**
 * X402-4 failure-mode harness. Reproduces each of the five deliberate
 * breakages from the ticket and prints server, client, and facilitator
 * output verbatim so dogfood-notes.md can be filled with no paraphrasing.
 *
 * Usage:
 *   pnpm tsx scripts/failure-modes.ts <1|2|3|4|5|all>
 *
 * Each function spins up its own in-process Hono server on a random port
 * so config tweaks (price, maxTimeoutSeconds, facilitator URL) don't
 * affect the dev-server defaults. Restores nothing because nothing is
 * mutated outside the function scope.
 */
import "dotenv/config";
import { Hono } from "hono";
import { paymentMiddleware } from "x402-hono";
import { wrapFetchWithPayment } from "x402-fetch";
import { createSigner } from "x402/types";
import { exact } from "x402/schemes";
import { createDogfoodApp } from "../src/dogfood/app.js";
import { startHonoServer, type ServerHandle } from "../src/dogfood/http-adapter.js";
import { loadServerConfig, loadClientConfig } from "../src/dogfood/config.js";

const REAL_FACILITATOR = "https://x402.org/facilitator";
const DEAD_FACILITATOR = "http://127.0.0.1:9";

type AppFactory = () => Hono;

async function withServer<T>(
  appFactory: AppFactory,
  body: (serverUrl: string) => Promise<T>,
): Promise<T> {
  const handle: ServerHandle = await startHonoServer(appFactory());
  try {
    return await body(handle.url);
  } finally {
    await handle.close();
  }
}

function divider(title: string): void {
  console.log("");
  console.log("================================================================");
  console.log(`  ${title}`);
  console.log("================================================================");
}

function section(title: string): void {
  console.log("");
  console.log(`--- ${title} ---`);
}

/**
 * 1. Wrong chain ID
 *
 * Server only accepts base-sepolia. Client signs a valid payment for
 * base-sepolia, then mutates the payment payload's `network` field to
 * "avalanche-fuji" before sending. Server's findMatchingPaymentRequirements
 * sees the payment claims avalanche-fuji but it only advertised
 * base-sepolia — no match.
 *
 * (Note: passing a different-chain wallet to x402-fetch does NOT trigger
 * this — x402-fetch signs against the requirements' chain id regardless
 * of the wallet's configured chain, and the signature is valid. Tried that
 * first and it produced a successful 200.)
 */
async function failure1_wrongChainId(): Promise<void> {
  divider("FAILURE 1: Wrong chain ID");
  const client = loadClientConfig();
  const baseAppConfig = loadServerConfig();

  await withServer(
    () =>
      createDogfoodApp({
        ...baseAppConfig,
        facilitatorUrl: REAL_FACILITATOR,
      }),
    async (serverUrl) => {
      const signer = await createSigner("base-sepolia", client.payerPrivateKey);
      const url = `${serverUrl}/api/weather`;

      section("server boot");
      console.log(`server: ${serverUrl}`);
      console.log("server only accepts: base-sepolia");

      section("unpaid GET — capture challenge");
      const unpaid = await fetch(url);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const challenge = (await unpaid.json()) as any;
      console.log(`unpaid -> ${unpaid.status}`);
      const requirements = challenge.accepts[0] as Parameters<typeof exact.evm.createPayment>[2];

      section("sign payment for base-sepolia normally");
      const evmSigner = signer as Parameters<typeof exact.evm.createPayment>[0];
      const payment = await exact.evm.createPayment(evmSigner, challenge.x402Version, requirements);
      console.log(`signed for network=${payment.network}`);

      section("MUTATE: rewrite payment.network to avalanche-fuji");
      const mutated = { ...payment, network: "avalanche-fuji" } as typeof payment;
      const header = exact.evm.encodePayment(mutated);
      console.log(`encoded payload now claims network=avalanche-fuji`);

      section("send X-PAYMENT with mutated network");
      const paid = await fetch(url, { method: "GET", headers: { "X-PAYMENT": header } });
      console.log(`paid -> ${paid.status}`);
      console.log("body:", await paid.text());
    },
  );
}

/**
 * 2. Expired validBefore / maxTimeoutSeconds
 *
 * Server's paymentMiddleware config sets maxTimeoutSeconds=-3600. Client
 * signs an EIP-3009 authorization with validBefore = now + (-3600) =
 * one hour in the past. Facilitator verifies and rejects: payment_expired.
 */
async function failure2_expired(): Promise<void> {
  divider("FAILURE 2: Expired validBefore / maxTimeoutSeconds");
  const client = loadClientConfig();
  const server = loadServerConfig();

  await withServer(
    () => {
      const app = new Hono();
      app.use(
        paymentMiddleware(
          server.receiverAddress,
          {
            "/api/weather": {
              price: "$0.001",
              network: "base-sepolia",
              config: {
                description: "X402-4 failure 2: negative maxTimeoutSeconds",
                maxTimeoutSeconds: -3600,
              },
            },
          },
          { url: REAL_FACILITATOR },
        ),
      );
      app.get("/api/weather", (c) => c.json({ ok: true }));
      return app;
    },
    async (serverUrl) => {
      const signer = await createSigner("base-sepolia", client.payerPrivateKey);
      const url = `${serverUrl}/api/weather`;

      section("server boot");
      console.log(`server: ${serverUrl}`);
      console.log("maxTimeoutSeconds: -3600 (validBefore will be 1 hour in the past)");

      section("unpaid GET");
      const unpaid = await fetch(url);
      console.log(`unpaid -> ${unpaid.status}`);
      console.log("challenge:", await unpaid.clone().text());

      section("paid GET via x402-fetch");
      const fetchWithPay = wrapFetchWithPayment(fetch, signer);
      try {
        const paid = await fetchWithPay(url, { method: "GET" });
        console.log(`paid -> ${paid.status}`);
        console.log("body:", await paid.text());
      } catch (err) {
        console.log("client threw:", err instanceof Error ? err.message : String(err));
      }
    },
  );
}

/**
 * 3. Insufficient USDC balance
 *
 * Server demands $100 USDC per request. Payer wallet has roughly $1 of
 * USDC. Facilitator verifies the signature, then checks on-chain balance
 * and rejects.
 */
async function failure3_insufficientBalance(): Promise<void> {
  divider("FAILURE 3: Insufficient USDC balance");
  const client = loadClientConfig();
  const server = loadServerConfig();

  await withServer(
    () => {
      const app = new Hono();
      app.use(
        paymentMiddleware(
          server.receiverAddress,
          {
            "/api/weather": {
              price: "$100.00",
              network: "base-sepolia",
              config: { description: "X402-4 failure 3: price way above wallet balance" },
            },
          },
          { url: REAL_FACILITATOR },
        ),
      );
      app.get("/api/weather", (c) => c.json({ ok: true }));
      return app;
    },
    async (serverUrl) => {
      const signer = await createSigner("base-sepolia", client.payerPrivateKey);
      const url = `${serverUrl}/api/weather`;

      section("server boot");
      console.log(`server: ${serverUrl}`);
      console.log("price: $100.00 (wallet has ~$1 USDC)");

      section("unpaid GET");
      const unpaid = await fetch(url);
      console.log(`unpaid -> ${unpaid.status}`);
      console.log("challenge:", await unpaid.clone().text());

      section("paid GET via x402-fetch");
      // Bump maxValue so x402-fetch's client-side cap doesn't short-circuit
      // before the facilitator gets a chance to reject. We want the real
      // insufficient-balance error from the verify step.
      const fetchWithPay = wrapFetchWithPayment(fetch, signer, 200_000_000n);
      try {
        const paid = await fetchWithPay(url, { method: "GET" });
        console.log(`paid -> ${paid.status}`);
        console.log("body:", await paid.text());
      } catch (err) {
        console.log("client threw:", err instanceof Error ? err.message : String(err));
      }
    },
  );
}

/**
 * 4. Malformed signature
 *
 * Construct a real payment payload, flip the last byte of the EIP-3009
 * signature, re-encode, send. The signature is well-formed length and
 * parses as a hex string, but recovery yields a wrong address.
 */
async function failure4_malformedSignature(): Promise<void> {
  divider("FAILURE 4: Malformed signature");
  const client = loadClientConfig();
  const server = loadServerConfig();

  await withServer(
    () =>
      createDogfoodApp({
        ...server,
        facilitatorUrl: REAL_FACILITATOR,
      }),
    async (serverUrl) => {
      const signer = await createSigner("base-sepolia", client.payerPrivateKey);
      const url = `${serverUrl}/api/weather`;

      section("server boot");
      console.log(`server: ${serverUrl}`);

      section("unpaid GET — capture challenge");
      const unpaid = await fetch(url);
      // The challenge body shape is x402-spec; trust it at runtime.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const challenge = (await unpaid.json()) as any;
      console.log(`unpaid -> ${unpaid.status}`);
      const requirements = challenge.accepts[0] as Parameters<typeof exact.evm.createPayment>[2];

      section("sign payment normally");
      // createSigner's return type is the broader Signer (EVM | SVM); narrow
      // it for exact.evm.createPayment, which only accepts the EVM half.
      const evmSigner = signer as Parameters<typeof exact.evm.createPayment>[0];
      const payment = await exact.evm.createPayment(evmSigner, challenge.x402Version, requirements);
      const evmPayload = payment.payload as { signature: `0x${string}`; authorization: unknown };
      const origSig = evmPayload.signature;
      console.log(`original signature: ${origSig}`);

      section("flip last byte of signature");
      // Swap the last hex byte to a different one. The result is still a
      // valid hex string and same length but recovers a different address.
      const lastByte = origSig.slice(-2);
      const flipped = (parseInt(lastByte, 16) ^ 0xff).toString(16).padStart(2, "0");
      const badSig = origSig.slice(0, -2) + flipped;
      console.log(`mangled signature:  ${badSig}`);

      const badPayment = {
        ...payment,
        payload: { ...evmPayload, signature: badSig as `0x${string}` },
      } as typeof payment;
      const badHeader = exact.evm.encodePayment(badPayment);

      section("send X-PAYMENT with mangled signature");
      const paid = await fetch(url, { method: "GET", headers: { "X-PAYMENT": badHeader } });
      console.log(`paid -> ${paid.status}`);
      console.log("body:", await paid.text());
    },
  );
}

/**
 * 5. Facilitator unavailable
 *
 * Server config points at a dead TCP port. Verify call inside
 * paymentMiddleware fails with a connection error. paymentMiddleware
 * catches it and returns a 402 with the underlying error message.
 */
async function failure5_facilitatorUnavailable(): Promise<void> {
  divider("FAILURE 5: Facilitator unavailable");
  const client = loadClientConfig();
  const server = loadServerConfig();

  await withServer(
    () =>
      createDogfoodApp({
        ...server,
        facilitatorUrl: DEAD_FACILITATOR,
      }),
    async (serverUrl) => {
      const signer = await createSigner("base-sepolia", client.payerPrivateKey);
      const url = `${serverUrl}/api/weather`;

      section("server boot");
      console.log(`server: ${serverUrl}`);
      console.log(`facilitator: ${DEAD_FACILITATOR} (nothing listening)`);

      section("unpaid GET");
      const unpaid = await fetch(url);
      console.log(`unpaid -> ${unpaid.status}`);
      console.log("challenge:", await unpaid.clone().text());

      section("paid GET via x402-fetch");
      const fetchWithPay = wrapFetchWithPayment(fetch, signer);
      try {
        const paid = await fetchWithPay(url, { method: "GET" });
        console.log(`paid -> ${paid.status}`);
        console.log("body:", await paid.text());
      } catch (err) {
        console.log("client threw:", err instanceof Error ? err.message : String(err));
      }
    },
  );
}

const FAILURES: Record<string, () => Promise<void>> = {
  "1": failure1_wrongChainId,
  "2": failure2_expired,
  "3": failure3_insufficientBalance,
  "4": failure4_malformedSignature,
  "5": failure5_facilitatorUnavailable,
};

async function main(): Promise<void> {
  const arg = process.argv[2] ?? "all";
  const toRun = arg === "all" ? Object.keys(FAILURES) : [arg];
  for (const key of toRun) {
    const fn = FAILURES[key];
    if (!fn) {
      console.error(`unknown failure mode: ${key}`);
      process.exitCode = 1;
      return;
    }
    try {
      await fn();
    } catch (err) {
      console.error(`failure ${key} threw outside the captured flow:`, err);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
