import "dotenv/config";
import { createMockFacilitator } from "../src/dogfood/mock-facilitator.js";
import { startHonoServer } from "../src/dogfood/http-adapter.js";

const PORT = Number(process.env.MOCK_FACILITATOR_PORT ?? 4402);

async function main(): Promise<void> {
  const mock = createMockFacilitator();
  const handle = await startHonoServer(mock.app, {
    port: PORT,
    logger: ({ method, path, status, durationMs }) => {
      const ts = new Date().toISOString();
      console.log(`[${ts}] mock-facilitator ${method} ${path} -> ${status} ${durationMs}ms`);
    },
  });
  console.log(`x402trace MOCK facilitator listening on ${handle.url}`);
  console.log("  WARNING: always approves. Local test harness only — do NOT deploy.");
  console.log("  To point the dogfood server at it, set in .env:");
  console.log(`     FACILITATOR_URL=${handle.url}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
