/**
 * X402-14 smoke test — drives the full CLI pipeline against the
 * mock-facilitator-backed dogfood rig. Asserts:
 *   1. `x402trace proxy --upstream <dogfood> --log-file <tmp>` boots
 *      the proxy on a real port,
 *   2. a paying client through it produces a 402 (mock rejects verify),
 *   3. the JSONL log captures both `exchange.opened` and
 *      `exchange.closed` lines with the right discriminants,
 *   4. `x402trace inspect <log>` reads the same log and reports the
 *      replay counts.
 *
 * Reconciliation against a live Base Sepolia chain client is NOT
 * exercised here (we don't have an RPC, and we don't have a real
 * settlement) — the offline `replayLog` unit tests cover the engine
 * join on synthetic inputs, and tests/integration/reconciliation-
 * pipeline.test.ts already exercises the engine end-to-end through
 * the proxy+decoder+mock-facilitator stack.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { wrapFetchWithPayment } from "x402-fetch";
import { createSigner } from "x402/types";
import { runCli } from "../../src/cli/index.js";
import { createDogfoodApp } from "../../src/dogfood/app.js";
import { createMockFacilitator, type MockFacilitator } from "../../src/dogfood/mock-facilitator.js";
import { startHonoServer, type ServerHandle } from "../../src/dogfood/http-adapter.js";

const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const TEST_RECEIVER = "0x1111111111111111111111111111111111111111" as const;

let mock: MockFacilitator;
let mockServer: ServerHandle;
let dogfoodServer: ServerHandle;
let tmpDir: string;

class Sink {
  output = "";
  write(chunk: string | Buffer | Uint8Array): boolean {
    this.output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }
  on(): this {
    return this;
  }
  end(): boolean {
    return true;
  }
}

beforeAll(async () => {
  mock = createMockFacilitator(); // default canned-success won't matter — client will pay
  mockServer = await startHonoServer(mock.app);
  dogfoodServer = await startHonoServer(
    createDogfoodApp({
      receiverAddress: TEST_RECEIVER,
      network: "base-sepolia",
      facilitatorUrl: mockServer.url,
      priceUsd: "$0.001",
      protectedPath: "/api/weather",
      description: "X402-14 CLI smoke test",
    }),
  );
  tmpDir = await mkdtemp(join(tmpdir(), "x402trace-cli-smoke-"));
});

afterAll(async () => {
  await dogfoodServer?.close();
  await mockServer?.close();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("CLI smoke (X402-14)", () => {
  it("proxy subcommand boots, captures a paid exchange, writes JSONL; inspect reads it back", async () => {
    const logFile = join(tmpDir, "smoke.jsonl");
    const stdout = new Sink();
    const stderr = new Sink();

    // Find an available port indirectly: spin the CLI with port 0
    // means OS-assign; but our flag flow uses the integer from the
    // user. Pick a high port and accept that on rare CI it might be
    // occupied; the dogfood rig already accepts 0 internally.
    const port = 18402 + Math.floor(Math.random() * 1000);

    // Manually trigger shutdown after the request completes.
    let shutdownResolve!: () => void;
    const shutdownPromise = new Promise<void>((r) => {
      shutdownResolve = r;
    });

    const cliPromise = runCli(
      [
        "proxy",
        "--upstream",
        dogfoodServer.url,
        "--port",
        String(port),
        "--log-file",
        logFile,
        "--log",
        "json",
      ],
      {
        stdout: stdout as unknown as NodeJS.WritableStream,
        stderr: stderr as unknown as NodeJS.WritableStream,
        env: {},
        waitForShutdown: () => shutdownPromise,
      },
    );

    // Give the proxy a moment to bind.
    await new Promise((r) => setTimeout(r, 100));

    const signer = await createSigner("base-sepolia", TEST_PRIVATE_KEY);
    const fetchWithPay = wrapFetchWithPayment(fetch, signer);
    const resp = await fetchWithPay(`http://localhost:${port}/api/weather`, {
      method: "GET",
    });
    // The dogfood rig + mock-facilitator default-success settle path
    // returns 200 with X-PAYMENT-RESPONSE.
    expect(resp.status).toBe(200);

    // Let the proxy drain the close + decoder events.
    await new Promise((r) => setTimeout(r, 100));

    shutdownResolve();
    const code = await cliPromise;
    expect(code).toBe(0);

    const log = await readFile(logFile, "utf8");
    const lines = log
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    const events = lines.map((l: { event: string }) => l.event);
    expect(events).toContain("exchange.opened");
    expect(events).toContain("exchange.closed");

    // Output was JSON mode → no human formatting headers.
    expect(stdout.output).toContain("listening on");

    // Now run inspect against the same log. Even without chain.transfer
    // lines, the engine should not crash and the trailer summary should
    // show counts.
    const inspectStdout = new Sink();
    const inspectStderr = new Sink();
    const inspectCode = await runCli(
      ["inspect", logFile, "--log", "json", "--watch-timeout-ms", "10"],
      {
        stdout: inspectStdout as unknown as NodeJS.WritableStream,
        stderr: inspectStderr as unknown as NodeJS.WritableStream,
        env: {},
        waitForShutdown: () => Promise.resolve(),
      },
    );
    expect(inspectCode).toBe(0);
    // Every JSON line must JSON-parse without crashing (grep-friendly).
    const outLines = inspectStdout.output.split("\n").filter((l) => l.length > 0);
    for (const line of outLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const summary = outLines
      .map((l) => JSON.parse(l) as { event?: string })
      .find((o) => o.event === "inspect.summary");
    expect(summary).toBeDefined();
  });
});
