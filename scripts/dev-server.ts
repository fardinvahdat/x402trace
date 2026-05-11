import "dotenv/config";
import { createDogfoodApp } from "../src/dogfood/app.js";
import { loadServerConfig } from "../src/dogfood/config.js";
import { startHonoServer } from "../src/dogfood/http-adapter.js";

const PORT = Number(process.env.DOGFOOD_PORT ?? 3402);

async function main(): Promise<void> {
  const config = loadServerConfig();
  const app = createDogfoodApp(config);
  const handle = await startHonoServer(app, {
    port: PORT,
    logger: ({ method, path, status, durationMs, requestHeaders, responseHeaders }) => {
      const ts = new Date().toISOString();
      const accept = requestHeaders.accept ?? "-";
      const xPay = requestHeaders["x-payment"] ? "x-payment:present" : "x-payment:none";
      const xPayResp = responseHeaders.get("x-payment-response")
        ? "x-payment-response:present"
        : "";
      const tail = [xPay, xPayResp].filter(Boolean).join(" ");
      console.log(
        `[${ts}] ${method} ${path} -> ${status} ${durationMs}ms accept=${accept} ${tail}`,
      );
    },
  });
  console.log(`x402trace dogfood server listening on ${handle.url}`);
  console.log(`  receiver:    ${config.receiverAddress}`);
  console.log(`  network:     ${config.network}`);
  console.log(`  facilitator: ${config.facilitatorUrl}`);
  console.log(`  protected:   GET ${config.protectedPath} @ ${config.priceUsd}`);
  console.log(`  unpaid GET:  curl -i ${handle.url}${config.protectedPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
