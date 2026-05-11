/**
 * Exponential-backoff retry for transient RPC failures.
 *
 * Per ARCHITECTURE.md § Chain RPC client: "RPC failures retry with
 * exponential backoff (max 3 attempts), then mark the watch as
 * degraded — the proxy keeps logging regardless."
 *
 * Retry classifier defaults to "anything that isn't an instance of
 * Error with name === 'AbortError'" — callers can override to be
 * stricter (e.g., only retry on 5xx / connection-reset / timeout).
 */

export interface RetryOptions {
  readonly retries?: number; // default 3
  readonly baseDelayMs?: number; // default 200
  readonly maxDelayMs?: number; // default 2000
  readonly shouldRetry?: (err: unknown, attempt: number) => boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const base = opts.baseDelayMs ?? 200;
  const max = opts.maxDelayMs ?? 2_000;
  const shouldRetry = opts.shouldRetry ?? defaultShouldRetry;

  let attempt = 0;
  // attempt 0 = initial call; retries are extra attempts after that.
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !shouldRetry(err, attempt)) throw err;
      const delay = Math.min(max, base * Math.pow(2, attempt));
      await sleep(delay);
      attempt += 1;
    }
  }
}

function defaultShouldRetry(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return false;
  return true;
}
