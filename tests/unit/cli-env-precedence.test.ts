/**
 * X402-17: env-var-vs-flag precedence tests for `x402trace proxy`.
 *
 * The contract is documented in [ARCHITECTURE.md § Configuration](../../ARCHITECTURE.md#configuration):
 * **CLI flag > env var > built-in default.**
 *
 * The dispatcher tests in `cli-dispatcher.test.ts` only exercise the
 * commander surface (help, version, unknown flags). The actual
 * precedence logic was previously buried inside `runProxyCommand` and
 * could only be tested by spinning up a real proxy. X402-17 extracts
 * `resolveProxyConfig(opts, env)` as a pure function specifically so
 * these rules can be pinned with cheap unit tests.
 */
import { describe, expect, it } from "vitest";
import { resolveProxyConfig } from "../../src/cli/proxy-command.js";

const NO_OPTS = {} as const;
const EMPTY_ENV = {} as const;

describe("resolveProxyConfig — required `upstream`", () => {
  it("fails with a clear message when neither --upstream nor X402TRACE_UPSTREAM is set", () => {
    const result = resolveProxyConfig(NO_OPTS, EMPTY_ENV);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/upstream/i);
  });

  it("accepts X402TRACE_UPSTREAM from env when the flag is absent", () => {
    const result = resolveProxyConfig(NO_OPTS, { X402TRACE_UPSTREAM: "http://env-upstream" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.upstream).toBe("http://env-upstream");
  });

  it("--upstream flag wins over X402TRACE_UPSTREAM env (flag > env precedence)", () => {
    const result = resolveProxyConfig(
      { upstream: "http://flag-upstream" },
      { X402TRACE_UPSTREAM: "http://env-upstream" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.upstream).toBe("http://flag-upstream");
  });
});

describe("resolveProxyConfig — per-field precedence (flag > env > default)", () => {
  function resolve(
    opts: Parameters<typeof resolveProxyConfig>[0] = {},
    env: Parameters<typeof resolveProxyConfig>[1] = {},
  ) {
    const result = resolveProxyConfig({ upstream: "http://x", ...opts }, env);
    if (!result.ok) throw new Error(`resolver failed: ${result.message}`);
    return result.config;
  }

  it("port defaults to 8402 when neither flag nor env is set", () => {
    expect(resolve().port).toBe(8402);
  });

  it("port honours X402TRACE_PORT env", () => {
    expect(resolve({}, { X402TRACE_PORT: "9000" }).port).toBe(9000);
  });

  it("port: --port flag wins over X402TRACE_PORT env", () => {
    expect(resolve({ port: 7000 }, { X402TRACE_PORT: "9000" }).port).toBe(7000);
  });

  it("port: malformed env value falls through to default", () => {
    // toIntOrNull returns null for non-numeric — must not propagate NaN
    expect(resolve({}, { X402TRACE_PORT: "soon" }).port).toBe(8402);
  });

  it("logPath defaults to ./x402trace.jsonl", () => {
    expect(resolve().logPath).toBe("./x402trace.jsonl");
  });

  it("logPath honours X402TRACE_LOG env", () => {
    expect(resolve({}, { X402TRACE_LOG: "/tmp/custom.jsonl" }).logPath).toBe("/tmp/custom.jsonl");
  });

  it("logPath: --log-file flag wins over X402TRACE_LOG env", () => {
    expect(
      resolve({ logFile: "/tmp/flag.jsonl" }, { X402TRACE_LOG: "/tmp/env.jsonl" }).logPath,
    ).toBe("/tmp/flag.jsonl");
  });

  it("reconcile defaults to false (opt-in per ARCHITECTURE)", () => {
    expect(resolve().reconcile).toBe(false);
  });

  it("reconcile: X402TRACE_RECONCILE=1 enables it", () => {
    expect(resolve({}, { X402TRACE_RECONCILE: "1" }).reconcile).toBe(true);
  });

  it("reconcile: X402TRACE_RECONCILE=true also enables it", () => {
    expect(resolve({}, { X402TRACE_RECONCILE: "true" }).reconcile).toBe(true);
  });

  it("reconcile: --reconcile flag overrides X402TRACE_RECONCILE=0", () => {
    expect(resolve({ reconcile: true }, { X402TRACE_RECONCILE: "0" }).reconcile).toBe(true);
  });

  it("reconcile: unknown truthy strings (e.g. 'sure') do NOT enable reconciliation", () => {
    expect(resolve({}, { X402TRACE_RECONCILE: "sure" }).reconcile).toBe(false);
  });

  it("rpcUrl is undefined by default (Chain client falls back to its own default)", () => {
    expect(resolve().rpcUrl).toBeUndefined();
  });

  it("rpcUrl honours BASE_RPC_URL env", () => {
    expect(resolve({}, { BASE_RPC_URL: "https://alchemy.example/k" }).rpcUrl).toBe(
      "https://alchemy.example/k",
    );
  });

  it("rpcUrl: --rpc-url flag wins over BASE_RPC_URL env", () => {
    expect(
      resolve({ rpcUrl: "https://flag.rpc" }, { BASE_RPC_URL: "https://env.rpc" }).rpcUrl,
    ).toBe("https://flag.rpc");
  });

  it("watchTimeoutMs defaults to 60_000", () => {
    expect(resolve().watchTimeoutMs).toBe(60_000);
  });

  it("watchTimeoutMs honours X402TRACE_WATCH_TIMEOUT_MS env", () => {
    expect(resolve({}, { X402TRACE_WATCH_TIMEOUT_MS: "12345" }).watchTimeoutMs).toBe(12345);
  });

  it("watchTimeoutMs: --watch-timeout-ms wins over env", () => {
    expect(
      resolve({ watchTimeoutMs: 99 }, { X402TRACE_WATCH_TIMEOUT_MS: "12345" }).watchTimeoutMs,
    ).toBe(99);
  });

  it("upstreamTimeoutMs is undefined by default (proxy uses its own default)", () => {
    expect(resolve().upstreamTimeoutMs).toBeUndefined();
  });

  it("upstreamTimeoutMs honours X402TRACE_UPSTREAM_TIMEOUT_MS env", () => {
    expect(resolve({}, { X402TRACE_UPSTREAM_TIMEOUT_MS: "5000" }).upstreamTimeoutMs).toBe(5000);
  });

  it("upstreamTimeoutMs: --upstream-timeout-ms wins over env", () => {
    expect(
      resolve({ upstreamTimeoutMs: 100 }, { X402TRACE_UPSTREAM_TIMEOUT_MS: "5000" })
        .upstreamTimeoutMs,
    ).toBe(100);
  });

  it("format defaults to 'human'", () => {
    expect(resolve().format).toBe("human");
  });

  it("format honours --log flag (no env source — stdout format is CLI-only)", () => {
    expect(resolve({ log: "json" }).format).toBe("json");
  });

  it("logSecrets defaults to false (redaction is on by default — secret-handling preference)", () => {
    expect(resolve().logSecrets).toBe(false);
  });

  it("logSecrets honours the --log-secrets flag", () => {
    expect(resolve({ logSecrets: true }).logSecrets).toBe(true);
  });

  // ─── X402-34: chain selection precedence ──────────────────────────

  it("chain defaults to 'base-sepolia' when neither flag nor env is set", () => {
    expect(resolve().chain).toBe("base-sepolia");
  });

  it("chain honours --chain flag", () => {
    expect(resolve({ chain: "base" }).chain).toBe("base");
  });

  it("chain honours BASE_CHAIN_ID env (string form)", () => {
    expect(resolve({}, { BASE_CHAIN_ID: "base" }).chain).toBe("base");
  });

  it("chain honours BASE_CHAIN_ID env (numeric form for both networks)", () => {
    expect(resolve({}, { BASE_CHAIN_ID: "8453" }).chain).toBe("base");
    expect(resolve({}, { BASE_CHAIN_ID: "84532" }).chain).toBe("base-sepolia");
  });

  it("--chain flag overrides BASE_CHAIN_ID env (flag-over-env precedence)", () => {
    expect(resolve({ chain: "base-sepolia" }, { BASE_CHAIN_ID: "base" }).chain).toBe(
      "base-sepolia",
    );
  });

  it("unrecognized BASE_CHAIN_ID values fall back to default base-sepolia (no crash)", () => {
    expect(resolve({}, { BASE_CHAIN_ID: "polygon" }).chain).toBe("base-sepolia");
  });

  it("BASE_CHAIN_ID parsing is case-insensitive", () => {
    expect(resolve({}, { BASE_CHAIN_ID: "BASE" }).chain).toBe("base");
    expect(resolve({}, { BASE_CHAIN_ID: "Base-Sepolia" }).chain).toBe("base-sepolia");
  });
});
