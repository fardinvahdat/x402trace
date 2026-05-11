/**
 * X402-11 decoder demo. Boots mock-facilitator + dogfood-server +
 * proxy in-process, runs one paid request through, prints the
 * human-formatted decoder output to stdout, then tears down.
 *
 * Use this to capture sample output for dogfood-notes.md when
 * verifying the "genuinely readable" acceptance criterion. Run as:
 *
 *   pnpm tsx scripts/decoder-demo.ts
 */
import { wrapFetchWithPayment } from "x402-fetch";
import { createSigner } from "x402/types";
import { createDogfoodApp } from "../src/dogfood/app.js";
import { createMockFacilitator } from "../src/dogfood/mock-facilitator.js";
import { startHonoServer } from "../src/dogfood/http-adapter.js";
import { createProxy } from "../src/proxy/index.js";
import { createDecoder, formatHuman } from "../src/decoder/index.js";

const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const TEST_RECEIVER = "0x1111111111111111111111111111111111111111" as const;

async function main(): Promise<void> {
  const mock = createMockFacilitator();
  const mockServer = await startHonoServer(mock.app);
  const dogfoodServer = await startHonoServer(
    createDogfoodApp({
      receiverAddress: TEST_RECEIVER,
      network: "base-sepolia",
      facilitatorUrl: mockServer.url,
      priceUsd: "$0.001",
      protectedPath: "/api/weather",
      description: "X402-11 decoder demo",
    }),
  );
  const proxy = await createProxy({ upstream: dogfoodServer.url, port: 0 });
  const decoder = createDecoder({ logSecrets: false });

  console.log(`# x402trace decoder demo`);
  console.log(`# proxy   :  ${proxy.url}  →  ${dogfoodServer.url}`);
  console.log(`# facilitator (mock) :  ${mockServer.url}`);
  console.log(``);

  const sub = proxy.events.subscribe();
  const collector = (async () => {
    for await (const event of sub) {
      // raw HTTP line first
      if (event.event === "exchange.opened") {
        console.log(
          `[${event.t}] HTTP ${event.request.method} ${event.request.path} (id=${event.id.slice(0, 8)})`,
        );
      } else if (event.event === "exchange.closed") {
        console.log(
          `[${event.t}] HTTP ${event.response.status} ${event.outcome.kind} (id=${event.id.slice(0, 8)}, ${event.durationMs}ms)`,
        );
      }
      // decoder-rendered lines, indented under the HTTP line they describe
      for (const decoded of decoder.decode(event)) {
        console.log(`  ${formatHuman(decoded)}`);
      }
    }
  })();

  const signer = await createSigner("base-sepolia", TEST_PRIVATE_KEY);
  const fetchWithPay = wrapFetchWithPayment(fetch, signer);
  const res = await fetchWithPay(`${proxy.url}/api/weather`, { method: "GET" });
  console.log(``);
  console.log(`# final HTTP status: ${res.status}`);
  console.log(`# body: ${await res.text()}`);

  await new Promise((r) => setTimeout(r, 50));
  sub.unsubscribe();
  await collector;

  await proxy.close();
  await dogfoodServer.close();
  await mockServer.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
