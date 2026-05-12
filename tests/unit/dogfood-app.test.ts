import { describe, expect, it } from "vitest";
import { createDogfoodApp } from "../../src/dogfood/app.js";
import type { DogfoodConfig } from "../../src/dogfood/config.js";

function fixtureConfig(): DogfoodConfig {
  return {
    receiverAddress: "0x1111111111111111111111111111111111111111",
    network: "base-sepolia",
    facilitatorUrl: "https://x402.org/facilitator",
    priceUsd: "$0.001",
    protectedPath: "/api/weather",
    description: "test description",
  };
}

describe("createDogfoodApp", () => {
  it("serves a service descriptor on GET /", async () => {
    const app = createDogfoodApp(fixtureConfig());
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.service).toBe("x402trace-dogfood");
    expect(body.protectedEndpoint).toBe("/api/weather");
    expect(body.network).toBe("base-sepolia");
    expect(body.price).toBe("$0.001");
  });

  it("returns 200 on GET /health", async () => {
    const app = createDogfoodApp(fixtureConfig());
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("returns 402 on the protected route when no X-PAYMENT header is supplied", async () => {
    const app = createDogfoodApp(fixtureConfig());
    const res = await app.request("/api/weather");
    expect(res.status).toBe(402);
  });

  it("does not gate /health behind a payment", async () => {
    const app = createDogfoodApp(fixtureConfig());
    const res = await app.request("/health");
    expect(res.status).not.toBe(402);
  });
});
