/**
 * X402-32 integration test — full bazaar-check pipeline with a single
 * fetcher mock servicing all four checks. Hermetic; no network.
 */
import { describe, expect, it } from "vitest";
import { runBazaarCheckCommand } from "../../src/cli/bazaar-check-command.js";

const SERVICE = "https://api.example.test/api/weather";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function challengeBody(extras: Record<string, unknown> = {}): unknown {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: "base-sepolia",
        maxAmountRequired: "1000",
        resource: SERVICE,
        payTo: PAY_TO,
        asset: USDC,
        maxTimeoutSeconds: 300,
      },
    ],
    extensions: { bazaar: { name: "Weather API", description: "Per-city forecasts" } },
    ...extras,
  };
}

function captureStream(): { stream: NodeJS.WritableStream; buf: string[] } {
  const buf: string[] = [];
  const stream: NodeJS.WritableStream = Object.assign(Object.create(null), {
    write(chunk: string | Uint8Array): boolean {
      buf.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
      return true;
    },
    end(): void {},
    on(): NodeJS.WritableStream {
      return stream;
    },
    once(): NodeJS.WritableStream {
      return stream;
    },
    emit(): boolean {
      return true;
    },
    removeListener(): NodeJS.WritableStream {
      return stream;
    },
  }) as NodeJS.WritableStream;
  return { stream, buf };
}

/**
 * Build a fetcher that dispatches the four well-known URLs the
 * bazaar-check pipeline hits.
 */
function buildFetcher(
  responses: {
    wellKnown?: () => Response;
    challenge?: () => Response;
    discovery?: () => Response;
  } = {},
): typeof fetch {
  return ((urlInput: string) => {
    const url = String(urlInput);
    if (url.endsWith("/.well-known/x402")) {
      return Promise.resolve(
        responses.wellKnown?.() ??
          jsonResponse({ name: "Weather API", description: "Forecasts", accepts: [] }),
      );
    }
    if (url.includes("discovery/resources")) {
      return Promise.resolve(
        responses.discovery?.() ?? jsonResponse({ resources: [{ id: "r1" }] }),
      );
    }
    // Fallback: treat as the challenge URL
    return Promise.resolve(
      responses.challenge?.() ??
        new Response(JSON.stringify(challengeBody()), {
          status: 402,
          headers: { "content-type": "application/json" },
        }),
    );
  }) as typeof fetch;
}

describe("bazaar-check pipeline (hermetic)", () => {
  it("returns exit 0 + looks_correct when all four checks pass", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runBazaarCheckCommand(
      { service: SERVICE, log: "json", chain: "base-sepolia" },
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {},
        fetcher: buildFetcher(),
      },
    );
    expect(code).toBe(0);
    const out = JSON.parse(stdout.buf.join(""));
    expect(out.verdict.kind).toBe("looks_correct");
    expect(out.results.map((r: { check: string }) => r.check)).toEqual([
      "well-known",
      "challenge",
      "self-payment",
      "indexing",
    ]);
  });

  it("returns exit 2 + implementation_issue when the well-known manifest is malformed", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runBazaarCheckCommand(
      { service: SERVICE, log: "json", chain: "base-sepolia" },
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {},
        fetcher: buildFetcher({
          wellKnown: () => new Response("oops", { status: 404 }),
        }),
      },
    );
    expect(code).toBe(2);
    const out = JSON.parse(stdout.buf.join(""));
    expect(out.verdict.kind).toBe("implementation_issue");
    expect(out.verdict.failedChecks).toContain("well-known");
  });

  it("returns exit 3 + upstream_issue when only indexing surfaces an info signal (the #2207 pattern)", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runBazaarCheckCommand(
      { service: SERVICE, log: "json", chain: "base-sepolia" },
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {},
        fetcher: buildFetcher({
          discovery: () => jsonResponse({ resources: [] }),
        }),
      },
    );
    expect(code).toBe(3);
    const out = JSON.parse(stdout.buf.join(""));
    expect(out.verdict.kind).toBe("upstream_issue");
    expect(out.verdict.message).toMatch(/#2207/);
  });

  it("returns exit 2 + implementation_issue when extensions.bazaar is missing", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runBazaarCheckCommand(
      { service: SERVICE, log: "json", chain: "base-sepolia" },
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {},
        fetcher: buildFetcher({
          challenge: () =>
            new Response(JSON.stringify(challengeBody({ extensions: undefined })), {
              status: 402,
              headers: { "content-type": "application/json" },
            }),
        }),
      },
    );
    expect(code).toBe(2);
    const out = JSON.parse(stdout.buf.join(""));
    expect(out.verdict.failedChecks).toContain("challenge");
  });

  it("renders a human-format report with check glyphs + a verdict line", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runBazaarCheckCommand(
      { service: SERVICE, log: "human", chain: "base-sepolia" },
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {},
        fetcher: buildFetcher(),
      },
    );
    expect(code).toBe(0);
    const text = stdout.buf.join("");
    expect(text).toContain("bazaar-check");
    expect(text).toContain("well-known");
    expect(text).toContain("challenge");
    expect(text).toContain("self-payment");
    expect(text).toContain("indexing");
    expect(text).toMatch(/VERDICT/);
  });

  it("aborts hung HTTP probes after --timeout-ms", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const hangingFetcher = ((_: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          },
          { once: true },
        );
      })) as typeof fetch;

    const code = await runBazaarCheckCommand(
      { service: SERVICE, log: "json", chain: "base-sepolia", timeoutMs: 5 },
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {},
        fetcher: hangingFetcher,
      },
    );

    expect(code).toBe(2);
    const out = JSON.parse(stdout.buf.join(""));
    expect(out.verdict.failedChecks).toContain("well-known");
    expect(out.verdict.failedChecks).toContain("challenge");
    expect(stdout.buf.join("")).toContain("aborted");
  });

  it("keeps the timeout active while reading a stalled response body", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const stalledBodyFetcher = ((urlInput: string, init?: RequestInit) => {
      const url = String(urlInput);
      if (url.endsWith("/.well-known/x402")) {
        const body = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(new Error("body aborted")),
              { once: true },
            );
          },
        });
        return Promise.resolve(
          new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
        );
      }
      return buildFetcher()(urlInput, init);
    }) as typeof fetch;

    const startedAt = Date.now();
    const code = await runBazaarCheckCommand(
      { service: SERVICE, log: "json", chain: "base-sepolia", timeoutMs: 5 },
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {},
        fetcher: stalledBodyFetcher,
      },
    );

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(code).toBe(2);
    const out = JSON.parse(stdout.buf.join(""));
    expect(out.verdict.failedChecks).toContain("well-known");
  });

  it("rejects timeout values above Node's timer maximum", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runBazaarCheckCommand(
      { service: SERVICE, chain: "base-sepolia", timeoutMs: 2_147_483_648 },
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {},
        fetcher: buildFetcher(),
      },
    );
    expect(code).toBe(1);
    expect(stderr.buf.join("")).toContain("2147483647");
  });

  it("rejects an invalid service URL with EXIT_USAGE", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runBazaarCheckCommand(
      { service: "not-a-url", chain: "base-sepolia" },
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {},
        fetcher: buildFetcher(),
      },
    );
    expect(code).toBe(1);
    expect(stderr.buf.join("")).toMatch(/valid URL/);
  });

  it("prints a mainnet banner when --chain base", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    await runBazaarCheckCommand(
      { service: SERVICE, log: "human", chain: "base" },
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {},
        fetcher: buildFetcher(),
      },
    );
    const text = stdout.buf.join("");
    expect(text).toMatch(/MAINNET/);
  });

  it("honours the payerHint and fails self-payment when payer == payTo", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runBazaarCheckCommand(
      { service: SERVICE, log: "json", chain: "base-sepolia", payerHint: PAY_TO },
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {},
        fetcher: buildFetcher(),
      },
    );
    expect(code).toBe(2);
    const out = JSON.parse(stdout.buf.join(""));
    expect(out.verdict.failedChecks).toContain("self-payment");
  });
});
