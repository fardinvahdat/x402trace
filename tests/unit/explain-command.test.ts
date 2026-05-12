/**
 * X402-21 v0.2 — unit tests for `x402trace explain`.
 *
 * Drives the command with a synthetic JSONL log (mirroring the shape
 * `proxy --reconcile` produces) and asserts the right exchanges get
 * diagnosed.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runExplainCommand,
  type ExplainCommandOptions,
  type ExplainRunContext,
} from "../../src/cli/explain-command.js";

const PAYER = "0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895";
const PAYEE = "0x1111111111111111111111111111111111111111";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NOW = new Date("2026-05-12T00:00:00Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

function capture() {
  let buf = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return {
    stream: stream as unknown as NodeJS.WritableStream,
    get output() {
      return buf;
    },
  };
}

function challengeLine(
  id: string,
  over: Partial<{ payTo: string; maxAmountRequired: string }> = {},
) {
  return JSON.stringify({
    event: "exchange.challenge",
    t: "2026-05-12T00:00:00Z",
    id,
    x402Version: 1,
    challenge: {
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: over.maxAmountRequired ?? "1000",
      resource: "http://example.test/api",
      payTo: over.payTo ?? PAYEE,
      asset: USDC,
      maxTimeoutSeconds: 300,
    },
  });
}

function paymentLine(
  id: string,
  over: Partial<{ to: string; value: string; validBefore: string }> = {},
) {
  return JSON.stringify({
    event: "exchange.payment",
    t: "2026-05-12T00:00:00Z",
    id,
    x402Version: 1,
    payment: {
      x402Version: 1,
      scheme: "exact",
      network: "base-sepolia",
      payload: {
        signature: "[REDACTED]",
        authorization: {
          from: PAYER,
          to: over.to ?? PAYEE,
          value: over.value ?? "1000",
          validAfter: "0",
          validBefore: over.validBefore ?? String(NOW_SEC + 300),
          nonce: `0x${"f".repeat(64)}`,
        },
      },
    },
  });
}

function reconcileLine(id: string, kind: string) {
  return JSON.stringify({
    event: "reconcile.result",
    t: "2026-05-12T00:00:01Z",
    exchangeId: id,
    kind,
  });
}

function decoderErrorLine(id: string | undefined, stage: string, message: string) {
  return JSON.stringify({
    event: "decoder.error",
    t: "2026-05-12T00:00:02Z",
    ...(id ? { id } : {}),
    stage,
    message,
  });
}

let tmp: string;
let logPath: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "x402-explain-"));
  logPath = path.join(tmp, "log.jsonl");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function makeCtx(over: Partial<ExplainRunContext> = {}): ExplainRunContext & {
  _out: ReturnType<typeof capture>;
  _err: ReturnType<typeof capture>;
} {
  const out = capture();
  const err = capture();
  return {
    stdout: out.stream,
    stderr: err.stream,
    now: () => NOW,
    _out: out,
    _err: err,
    ...over,
  };
}

describe("runExplainCommand — usage errors", () => {
  it("exits 1 when the log file argument is missing", async () => {
    const ctx = makeCtx();
    const code = await runExplainCommand({} as ExplainCommandOptions, ctx);
    expect(code).toBe(1);
  });

  it("exits 1 when the log file doesn't exist", async () => {
    const ctx = makeCtx();
    const code = await runExplainCommand({ logFile: path.join(tmp, "missing.jsonl") }, ctx);
    expect(code).toBe(1);
    expect(ctx._err.output).toMatch(/cannot read/);
  });

  it("exits 1 when the path is a directory", async () => {
    const dirPath = path.join(tmp, "dir");
    await mkdir(dirPath, { recursive: true });
    const ctx = makeCtx();
    const code = await runExplainCommand({ logFile: dirPath }, ctx);
    expect(code).toBe(1);
  });
});

describe("runExplainCommand — diagnosis", () => {
  it("exits 0 with a clean message when the log has no failed exchanges", async () => {
    await writeFile(
      logPath,
      [
        challengeLine("01HZX-1"),
        paymentLine("01HZX-1"),
        reconcileLine("01HZX-1", "settled_on_chain"),
      ].join("\n"),
    );
    const ctx = makeCtx();
    const code = await runExplainCommand({ logFile: logPath }, ctx);
    expect(code).toBe(0);
    expect(ctx._out.output).toMatch(/explained 0 failed/);
  });

  it("renders a diagnose report for each non-settled reconcile.result", async () => {
    await writeFile(
      logPath,
      [
        challengeLine("01HZX-1"),
        paymentLine("01HZX-1", { to: "0x2222222222222222222222222222222222222222" }),
        reconcileLine("01HZX-1", "not_settled"),
      ].join("\n"),
    );
    const ctx = makeCtx();
    const code = await runExplainCommand({ logFile: logPath }, ctx);
    expect(code).toBe(2);
    // The recipient-mismatch rule should fire on the payment / requirements diff
    expect(ctx._out.output).toMatch(/recipient-match/);
    expect(ctx._out.output).toMatch(/not_settled/);
  });

  it("surfaces decoder.error events even without an exchange diagnose", async () => {
    await writeFile(logPath, decoderErrorLine("01HZX-1", "payment", "upstream timeout"));
    const ctx = makeCtx();
    const code = await runExplainCommand({ logFile: logPath }, ctx);
    expect(code).toBe(2);
    expect(ctx._out.output).toMatch(/decoder\.error/);
    expect(ctx._out.output).toMatch(/upstream timeout/);
  });

  it("emits JSON output when --log json (every line round-trips through JSON.parse)", async () => {
    await writeFile(
      logPath,
      [
        challengeLine("01HZX-1"),
        paymentLine("01HZX-1", { value: "10" }),
        reconcileLine("01HZX-1", "not_settled"),
      ].join("\n"),
    );
    const ctx = makeCtx();
    await runExplainCommand({ logFile: logPath, log: "json" }, ctx);
    const lines = ctx._out.output.trim().split("\n").filter(Boolean);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // Should include at least one explain.exchange header and the trailing summary.
    expect(lines.some((l) => JSON.parse(l).event === "explain.exchange")).toBe(true);
    expect(JSON.parse(lines[lines.length - 1]!).event).toBe("explain.summary");
  });

  it("warns when a failed reconcile has no captured challenge in the log", async () => {
    // No challenge line, just a reconcile.result.
    await writeFile(logPath, reconcileLine("01HZX-1", "not_settled"));
    const ctx = makeCtx();
    const code = await runExplainCommand({ logFile: logPath }, ctx);
    expect(code).toBe(0); // No actual diagnosis was produced
    expect(ctx._out.output).toMatch(/no challenge in log/);
  });

  it("skips lines that aren't valid JSON without crashing", async () => {
    await writeFile(
      logPath,
      [
        "{garbage}",
        "",
        challengeLine("01HZX-1"),
        "not json either",
        paymentLine("01HZX-1"),
        reconcileLine("01HZX-1", "settled_on_chain"),
      ].join("\n"),
    );
    const ctx = makeCtx();
    const code = await runExplainCommand({ logFile: logPath }, ctx);
    expect(code).toBe(0);
  });
});
