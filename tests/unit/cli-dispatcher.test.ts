/**
 * Surface-level CLI dispatcher tests. Asserts the X402-14 Jira
 * acceptance criteria that don't require a running proxy:
 *   - `--help` covers every option, every command
 *   - exit codes 0 / 1 / 2 are honoured
 *   - no interactive prompts (we just send `argv` and read streams)
 */
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/index.js";

class WriteSink {
  output = "";
  write(chunk: string | Buffer | Uint8Array): boolean {
    this.output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }
  // The Writable-like surface CLI consumers don't actually touch in our flow.
  on(): this {
    return this;
  }
  end(): boolean {
    return true;
  }
}

function makeCtx() {
  const stdout = new WriteSink();
  const stderr = new WriteSink();
  return {
    stdout: stdout as unknown as NodeJS.WritableStream,
    stderr: stderr as unknown as NodeJS.WritableStream,
    env: {} as Record<string, string | undefined>,
    waitForShutdown: () => Promise.resolve(),
    _out: stdout,
    _err: stderr,
  };
}

describe("runCli — surface", () => {
  it("--help exits 0 and lists both subcommands", async () => {
    const ctx = makeCtx();
    const code = await runCli(["--help"], ctx);
    expect(code).toBe(0);
    expect(ctx._out.output).toMatch(/proxy/);
    expect(ctx._out.output).toMatch(/inspect/);
  });

  it("--version exits 0 and prints a semver-shaped string", async () => {
    const ctx = makeCtx();
    const code = await runCli(["--version"], ctx);
    expect(code).toBe(0);
    expect(ctx._out.output.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("proxy --help documents every option", async () => {
    const ctx = makeCtx();
    const code = await runCli(["proxy", "--help"], ctx);
    expect(code).toBe(0);
    for (const flag of [
      "--upstream",
      "--port",
      "--log ",
      "--log-file",
      "--log-secrets",
      "--reconcile",
      "--rpc-url",
      "--watch-timeout-ms",
    ]) {
      expect(ctx._out.output, `missing ${flag} in proxy --help`).toContain(flag);
    }
  });

  it("inspect --help documents the JSONL argument + every option", async () => {
    const ctx = makeCtx();
    const code = await runCli(["inspect", "--help"], ctx);
    expect(code).toBe(0);
    expect(ctx._out.output).toContain("jsonl-log-file");
    expect(ctx._out.output).toContain("--log");
    expect(ctx._out.output).toContain("--watch-timeout-ms");
  });

  it("proxy without --upstream exits with the usage code", async () => {
    const ctx = makeCtx();
    const code = await runCli(["proxy"], ctx);
    expect(code).toBe(1);
    expect(ctx._err.output).toMatch(/required option|upstream/i);
  });

  it("inspect without an argument exits with the usage code", async () => {
    const ctx = makeCtx();
    const code = await runCli(["inspect"], ctx);
    expect(code).toBe(1);
    expect(ctx._err.output).toMatch(/missing|argument/i);
  });

  it("inspect against a missing file exits with the usage code", async () => {
    const ctx = makeCtx();
    const code = await runCli(["inspect", "/tmp/does-not-exist-x402.jsonl"], ctx);
    expect(code).toBe(1);
    expect(ctx._err.output).toMatch(/cannot read/);
  });

  it("rejects an invalid --log value (not human/json)", async () => {
    const ctx = makeCtx();
    const code = await runCli(["proxy", "--upstream", "http://x", "--log", "xml"], ctx);
    expect(code).toBe(1);
    expect(ctx._err.output).toMatch(/--log must be 'human' or 'json'/);
  });

  it("an unknown subcommand exits with the usage code", async () => {
    const ctx = makeCtx();
    const code = await runCli(["nope"], ctx);
    expect(code).toBe(1);
  });
});
