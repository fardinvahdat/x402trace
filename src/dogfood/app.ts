import { Hono } from "hono";
import { paymentMiddleware } from "x402-hono";
import type { DogfoodConfig } from "./config.js";

export interface DogfoodResponse {
  readonly endpoint: string;
  readonly network: string;
  readonly priceUsd: string;
  readonly servedAt: string;
  readonly note: string;
}

export function createDogfoodApp(config: DogfoodConfig): Hono {
  const app = new Hono();

  app.get("/", (c) =>
    c.json({
      service: "x402trace-dogfood",
      protectedEndpoint: config.protectedPath,
      network: config.network,
      price: config.priceUsd,
      note: "GET the protected endpoint without payment to see a 402.",
    }),
  );

  app.get("/health", (c) => c.json({ ok: true }));

  app.use(
    paymentMiddleware(
      config.receiverAddress,
      {
        [config.protectedPath]: {
          price: config.priceUsd,
          network: config.network,
          config: { description: config.description },
        },
      },
      { url: config.facilitatorUrl as `${string}://${string}` },
    ),
  );

  app.get(config.protectedPath, async (c) => {
    // X402-15 demo path: x402-hono verifies BEFORE this handler and
    // settles AFTER it returns a 2xx. A long handler sleep + a shorter
    // proxy upstream timeout = buyer-facing 502 while settlement is
    // still pending; once the handler returns 200, /settle fires and
    // the on-chain transfer lands.
    if (config.demoSleepMs && config.demoSleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, config.demoSleepMs));
    }
    // `demoFailAfterSleep` is a documented FAILURE path — x402-hono
    // skips /settle on 5xx, so this branch produces a `not_settled`
    // result, not the canonical `settled_on_chain` warning. See
    // DogfoodConfig.demoFailAfterSleep for details.
    if (config.demoFailAfterSleep) {
      return c.json({ error: "demo: simulated post-settle server failure" }, 500);
    }
    const body: DogfoodResponse = {
      endpoint: config.protectedPath,
      network: config.network,
      priceUsd: config.priceUsd,
      servedAt: new Date().toISOString(),
      note: "Paid response from x402trace dogfood server on Base Sepolia.",
    };
    return c.json(body);
  });

  return app;
}
