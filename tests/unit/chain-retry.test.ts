import { describe, expect, it, vi } from "vitest";
import { withRetry } from "../../src/chain/retry.js";

describe("withRetry", () => {
  it("returns the value on first success", async () => {
    const fn = vi.fn(async () => 42);
    await expect(withRetry(fn, { retries: 3, baseDelayMs: 1 })).resolves.toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure up to `retries` extra attempts", async () => {
    let calls = 0;
    const fn = async (): Promise<string> => {
      calls += 1;
      if (calls < 3) throw new Error("flaky");
      return "ok";
    };
    await expect(withRetry(fn, { retries: 3, baseDelayMs: 1 })).resolves.toBe("ok");
    expect(calls).toBe(3);
  });

  it("throws the last error after exhausting retries", async () => {
    const fn = vi.fn(async () => {
      throw new Error("permanent");
    });
    await expect(withRetry(fn, { retries: 2, baseDelayMs: 1 })).rejects.toThrow("permanent");
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("does not retry when shouldRetry returns false", async () => {
    const fn = vi.fn(async () => {
      throw new Error("fatal");
    });
    await expect(
      withRetry(fn, { retries: 5, baseDelayMs: 1, shouldRetry: () => false }),
    ).rejects.toThrow("fatal");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("respects exponential backoff schedule (sleeps between attempts)", async () => {
    const start = Date.now();
    let attempts = 0;
    const fn = async (): Promise<number> => {
      attempts += 1;
      if (attempts < 3) throw new Error("retry me");
      return 7;
    };
    await withRetry(fn, { retries: 3, baseDelayMs: 50, maxDelayMs: 200 });
    const elapsed = Date.now() - start;
    // attempt 0 fails, sleep 50ms, attempt 1 fails, sleep 100ms, attempt 2 succeeds.
    // So minimum elapsed is ~150ms.
    expect(elapsed).toBeGreaterThanOrEqual(140);
  });
});
