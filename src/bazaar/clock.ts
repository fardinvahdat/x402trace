/**
 * X402-52 (v0.3.4 I, ADR-006) — injectable clock abstraction.
 *
 * The reachability check uses wall-clock time to:
 *   - Stamp `bazaar.probe_attempt` records (`t` field, ISO-8601 UTC)
 *   - Compute probe-history window membership (is the prior probe still
 *     within the per-cause consensus window?)
 *
 * Tests inject a mock clock to step through 5+ minute windows without
 * real `setTimeout`. Production uses `realClock`.
 *
 * Why a `Clock` interface vs `vi.useFakeTimers()`: avoids global-mock
 * side effects across the test suite; per-test injection is hermetic.
 */

export interface Clock {
  /** Unix epoch milliseconds. */
  now(): number;
  /** ISO-8601 UTC timestamp at current instant. */
  nowIso(): string;
}

export const realClock: Clock = {
  now: () => Date.now(),
  nowIso: () => new Date().toISOString(),
};

/** Test helper. Manually step time forward with `mockClock.advance(ms)`. */
export interface MockClock extends Clock {
  advance(ms: number): void;
  setEpoch(ms: number): void;
}

export function createMockClock(initialEpochMs = 1_748_520_000_000): MockClock {
  let current = initialEpochMs;
  return {
    now: () => current,
    nowIso: () => new Date(current).toISOString(),
    advance: (ms: number) => {
      current += ms;
    },
    setEpoch: (ms: number) => {
      current = ms;
    },
  };
}
