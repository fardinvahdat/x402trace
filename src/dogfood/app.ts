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
    // X402-15 demo path: the x402 middleware has already run verify+settle
    // by the time we get here — so a post-settle sleep / 500 reproduces
    // the "settled-on-chain but client doesn't know it" symptom.
    if (config.demoSleepMs && config.demoSleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, config.demoSleepMs));
    }
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
