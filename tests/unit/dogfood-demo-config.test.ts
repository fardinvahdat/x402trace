/**
 * X402-15 demo-knob env wiring tests.
 *
 * `DEMO_SLEEP_MS` and `DEMO_FAIL_AFTER_SLEEP` exist so the end-to-end
 * timeout-reconciliation demo can deterministically reproduce the
 * "settled-but-server-thinks-not" symptom. They're test-rig only and
 * must not pollute the default config — verify both directions.
 */
import { describe, expect, it } from "vitest";
import { ConfigError, loadServerConfig } from "../../src/dogfood/config.js";

const VALID_RECEIVER = "0x1111111111111111111111111111111111111111";
const VALID_FACILITATOR = "https://x402.org/facilitator";

function envWith(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return {
    RECEIVER_ADDRESS: VALID_RECEIVER,
    FACILITATOR_URL: VALID_FACILITATOR,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("loadServerConfig — demo knobs (X402-15)", () => {
  it("leaves demoSleepMs / demoFailAfterSleep unset when env is blank", () => {
    const config = loadServerConfig(envWith({}));
    expect(config.demoSleepMs).toBeUndefined();
    expect(config.demoFailAfterSleep).toBeUndefined();
  });

  it("propagates DEMO_SLEEP_MS when a positive integer is supplied", () => {
    const config = loadServerConfig(envWith({ DEMO_SLEEP_MS: "1500" }));
    expect(config.demoSleepMs).toBe(1500);
  });

  it("drops DEMO_SLEEP_MS=0 (no-op sleep is identical to no sleep)", () => {
    const config = loadServerConfig(envWith({ DEMO_SLEEP_MS: "0" }));
    expect(config.demoSleepMs).toBeUndefined();
  });

  it("rejects a non-numeric DEMO_SLEEP_MS", () => {
    expect(() => loadServerConfig(envWith({ DEMO_SLEEP_MS: "soon" }))).toThrow(ConfigError);
  });

  it("rejects a negative DEMO_SLEEP_MS", () => {
    expect(() => loadServerConfig(envWith({ DEMO_SLEEP_MS: "-1" }))).toThrow(ConfigError);
  });

  it("recognises DEMO_FAIL_AFTER_SLEEP=1 as truthy", () => {
    const config = loadServerConfig(envWith({ DEMO_FAIL_AFTER_SLEEP: "1" }));
    expect(config.demoFailAfterSleep).toBe(true);
  });

  it("recognises DEMO_FAIL_AFTER_SLEEP=true as truthy", () => {
    const config = loadServerConfig(envWith({ DEMO_FAIL_AFTER_SLEEP: "true" }));
    expect(config.demoFailAfterSleep).toBe(true);
  });

  it("ignores DEMO_FAIL_AFTER_SLEEP=0", () => {
    const config = loadServerConfig(envWith({ DEMO_FAIL_AFTER_SLEEP: "0" }));
    expect(config.demoFailAfterSleep).toBeUndefined();
  });
});
