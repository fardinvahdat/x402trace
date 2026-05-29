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
    discoveryMerchant?: () => Response;
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
    if (url.includes("discovery/merchant")) {
      // X402-53 (L) — host-pollution queries merchant endpoint.
      // Default: single host, no pollution.
      return Promise.resolve(
        responses.discoveryMerchant?.() ??
          jsonResponse({
            pagination: { limit: 50, offset: 0, total: 1 },
            resources: [{ resource: "https://api.example.com/api/weather" }],
          }),
      );
    }
    if (url.includes("discovery/resources")) {
      return Promise.resolve(
        responses.discovery?.() ??
          // Resource includes name + description so the propagation check
          // (X402-45 / D.2) diffs as `ok` rather than `missing`.
          jsonResponse({ resources: [{ name: "Weather API", description: "Forecasts" }] }),
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
  it("returns exit 0 + looks_correct when all seven checks pass", async () => {
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
    // X402-51 (G) — facilitator-fitness appended as 7th check (additive per ADR-005).
    expect(out.results.map((r: { check: string }) => r.check)).toEqual([
      "well-known",
      "challenge",
      "self-payment",
      "indexing",
      "propagation",
      "host-pollution",
      "facilitator-fitness",
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

  it("returns exit 3 + upstream_stuck when indexing surfaces processing (the #2207 pattern, X402-46/D.3)", async () => {
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
    expect(out.verdict.kind).toBe("upstream_stuck");
    expect(out.verdict.message).toMatch(/#2207/);
    // Confirm the indexer_state facet is present and carrying the
    // processing signal that drove the verdict choice.
    const indexing = out.results.find((r: { check: string }) => r.check === "indexing");
    expect(indexing.detail.indexer_state).toBe("processing");
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

  // ---- X402-42 (D.4) — `--endpoint <paid-url>` per-route probe mode ----
  //
  // AsaiShota + evanatpizzarobot + 0xdespot all publish per-route on
  // #2207 — root /.well-known/x402 returns 404 even though the per-route
  // 402 challenge is well-formed. D.4 adds a flag to bypass the root
  // probe and read the challenge directly from a paid endpoint.

  describe("--endpoint mode (D.4)", () => {
    const ENDPOINT = "https://api.example.test/api/premium/route";

    /**
     * Per-route fetcher: well-known URL is unreachable (404); challenge
     * available at the endpoint URL with a well-formed body.
     */
    function endpointModeFetcher(
      overrides: {
        challenge?: () => Response;
        discovery?: () => Response;
      } = {},
    ): typeof fetch {
      return ((urlInput: string) => {
        const url = String(urlInput);
        if (url.endsWith("/.well-known/x402")) {
          // Per-route services: root returns 404. Test asserts the
          // bazaar-check pipeline does NOT call this URL under --endpoint.
          return Promise.resolve(new Response("not found", { status: 404 }));
        }
        if (url.includes("discovery/resources")) {
          return Promise.resolve(
            overrides.discovery?.() ?? jsonResponse({ resources: [{ id: "r1" }] }),
          );
        }
        // Challenge — endpoint URL OR (under default mode) service URL
        return Promise.resolve(
          overrides.challenge?.() ??
            new Response(JSON.stringify(challengeBody()), {
              status: 402,
              headers: { "content-type": "application/json" },
            }),
        );
      }) as typeof fetch;
    }

    it("happy path: skips well-known, fetches challenge from endpoint, returns looks_correct", async () => {
      const stdout = captureStream();
      const stderr = captureStream();
      const fetchedUrls: string[] = [];
      const fetcher = ((urlInput: string) => {
        fetchedUrls.push(String(urlInput));
        return endpointModeFetcher()(urlInput as unknown as Parameters<typeof fetch>[0]);
      }) as typeof fetch;

      const code = await runBazaarCheckCommand(
        {
          service: SERVICE,
          endpoint: ENDPOINT,
          log: "json",
          chain: "base-sepolia",
        },
        { stdout: stdout.stream, stderr: stderr.stream, env: {}, fetcher },
      );

      expect(code).toBe(0);
      const out = JSON.parse(stdout.buf.join(""));
      expect(out.verdict.kind).toBe("looks_correct");

      // well-known result is present but marked as skipped (status: pass)
      const wk = out.results.find((r: { check: string }) => r.check === "well-known");
      expect(wk.status).toBe("pass");
      expect(wk.message).toMatch(/skipped per --endpoint/);

      // Critical: well-known URL was NEVER fetched
      expect(fetchedUrls.some((u) => u.endsWith("/.well-known/x402"))).toBe(false);

      // Critical: the endpoint URL WAS fetched (used as challenge URL)
      expect(fetchedUrls).toContain(ENDPOINT);
    });

    it("returns implementation_issue when the endpoint returns 402 with a malformed challenge body", async () => {
      const stdout = captureStream();
      const stderr = captureStream();
      const code = await runBazaarCheckCommand(
        {
          service: SERVICE,
          endpoint: ENDPOINT,
          log: "json",
          chain: "base-sepolia",
        },
        {
          stdout: stdout.stream,
          stderr: stderr.stream,
          env: {},
          fetcher: endpointModeFetcher({
            // Challenge body missing extensions.bazaar
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
      expect(out.verdict.kind).toBe("implementation_issue");
      expect(out.verdict.failedChecks).toContain("challenge");
      // well-known still skipped (no false-positive on missing root manifest)
      expect(out.verdict.failedChecks).not.toContain("well-known");
    });

    it("returns implementation_issue when the endpoint returns 2xx (no 402 challenge)", async () => {
      const stdout = captureStream();
      const stderr = captureStream();
      const code = await runBazaarCheckCommand(
        {
          service: SERVICE,
          endpoint: ENDPOINT,
          log: "json",
          chain: "base-sepolia",
        },
        {
          stdout: stdout.stream,
          stderr: stderr.stream,
          env: {},
          fetcher: endpointModeFetcher({
            challenge: () => new Response('{"ok":true}', { status: 200 }),
          }),
        },
      );

      expect(code).toBe(2);
      const out = JSON.parse(stdout.buf.join(""));
      expect(out.verdict.failedChecks).toContain("challenge");
      const challenge = out.results.find((r: { check: string }) => r.check === "challenge");
      expect(challenge.message).toMatch(/expected HTTP 402/);
      expect(challenge.message).toMatch(/200/);
    });

    it("rejects an invalid --endpoint value with exit code 1", async () => {
      const stdout = captureStream();
      const stderr = captureStream();
      const code = await runBazaarCheckCommand(
        {
          service: SERVICE,
          endpoint: "not a valid url",
          log: "json",
          chain: "base-sepolia",
        },
        { stdout: stdout.stream, stderr: stderr.stream, env: {}, fetcher: endpointModeFetcher() },
      );

      expect(code).toBe(1);
      expect(stderr.buf.join("")).toMatch(/--endpoint must be a valid URL/);
    });

    it("prints the UX note to stdout in human format", async () => {
      const stdout = captureStream();
      const stderr = captureStream();
      await runBazaarCheckCommand(
        {
          service: SERVICE,
          endpoint: ENDPOINT,
          log: "human",
          chain: "base-sepolia",
        },
        { stdout: stdout.stream, stderr: stderr.stream, env: {}, fetcher: endpointModeFetcher() },
      );

      const stdoutText = stdout.buf.join("");
      expect(stdoutText).toMatch(/skipping root \/\.well-known\/x402 probe per --endpoint/);
      expect(stdoutText).toMatch(/services that DO publish at root signal/);
      // stderr should NOT contain the note in human format
      expect(stderr.buf.join("")).not.toMatch(/skipping root \/\.well-known/);
    });

    it("prints the UX note to stderr in json format (keeps stdout JSON-parseable)", async () => {
      const stdout = captureStream();
      const stderr = captureStream();
      await runBazaarCheckCommand(
        {
          service: SERVICE,
          endpoint: ENDPOINT,
          log: "json",
          chain: "base-sepolia",
        },
        { stdout: stdout.stream, stderr: stderr.stream, env: {}, fetcher: endpointModeFetcher() },
      );

      expect(stderr.buf.join("")).toMatch(
        /skipping root \/\.well-known\/x402 probe per --endpoint/,
      );
      // stdout must remain valid JSON (no info-note pollution)
      const stdoutText = stdout.buf.join("");
      expect(() => JSON.parse(stdoutText)).not.toThrow();
    });
  });
});
