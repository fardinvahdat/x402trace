/**
 * X402-36 unit tests — versions SDK skew audit.
 *
 * Covers: package.json walk-up, x402-dep extraction, known-skew
 * matching (any vs exact), service-side version hints, and the
 * report verdict.
 */
import { Writable } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractX402Versions,
  findPackageJson,
  runVersionsAudit,
  runVersionsCommand,
  type KnownSkewDataset,
  type VersionsRunContext,
} from "../../src/cli/versions-command.js";

const SERVICE = "http://example.test/api";

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

function makeCtx(over: Partial<VersionsRunContext> = {}) {
  const out = capture();
  const err = capture();
  return {
    ctx: { stdout: out.stream, stderr: err.stream, ...over } as VersionsRunContext,
    out,
    err,
  };
}

const VALID_CHALLENGE = {
  x402Version: 1,
  accepts: [
    {
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "1000",
      resource: SERVICE,
      payTo: "0x1111111111111111111111111111111111111111",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      maxTimeoutSeconds: 300,
    },
  ],
};

describe("extractX402Versions", () => {
  it("returns empty object for non-objects or null", () => {
    expect(extractX402Versions(null)).toEqual({});
    expect(extractX402Versions("string")).toEqual({});
    expect(extractX402Versions(42)).toEqual({});
  });

  it("extracts @x402/* deps from dependencies + devDependencies", () => {
    const out = extractX402Versions({
      dependencies: {
        "@x402/fetch": "^2.10.0",
        "@x402/hono": "2.11.0",
        commander: "^14.0.0",
      },
      devDependencies: {
        "@x402/core": "2.11.0",
        prettier: "^3.0.0",
      },
    });
    expect(out).toEqual({
      "@x402/fetch": "^2.10.0",
      "@x402/hono": "2.11.0",
      "@x402/core": "2.11.0",
    });
  });

  it("extracts the bare 'x402' package", () => {
    const out = extractX402Versions({ dependencies: { x402: "^1.2.0" } });
    expect(out).toEqual({ x402: "^1.2.0" });
  });

  it("extracts x402-* packages (older naming convention)", () => {
    const out = extractX402Versions({ dependencies: { "x402-fetch": "1.2.0" } });
    expect(out).toEqual({ "x402-fetch": "1.2.0" });
  });

  it("ignores non-string version values gracefully", () => {
    const out = extractX402Versions({ dependencies: { "@x402/fetch": null } });
    expect(out).toEqual({});
  });
});

describe("findPackageJson", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "x402trace-versions-test-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns null when no package.json exists in the directory chain", async () => {
    const r = await findPackageJson(tmp);
    // tmpdir() typically doesn't have a package.json up the chain on macOS/Linux
    // BUT some CI runners do. Accept null OR a path-outside-tmp.
    if (r !== null) {
      expect(r.startsWith(tmp)).toBe(false);
    }
  });

  it("finds a package.json at the cwd if present", async () => {
    const pkgPath = join(tmp, "package.json");
    await writeFile(pkgPath, "{}");
    const r = await findPackageJson(tmp);
    expect(r).toBe(pkgPath);
  });

  it("walks up to find a parent's package.json", async () => {
    const pkgPath = join(tmp, "package.json");
    await writeFile(pkgPath, "{}");
    const childDir = join(tmp, "deep", "child");
    await mkdir(childDir, { recursive: true });
    const r = await findPackageJson(childDir);
    expect(r).toBe(pkgPath);
  });
});

describe("runVersionsAudit", () => {
  const TEST_SKEW: KnownSkewDataset = {
    version: 1,
    entries: [
      {
        id: "fetch-bug",
        package: "@x402/fetch",
        match: "exact",
        version: "2.10.0",
        severity: "warning",
        summary: "fetch 2.10.0 misses extensions echo",
        fix: "upgrade to 2.11+",
      },
      {
        id: "hono-default",
        package: "@x402/hono",
        match: "any",
        severity: "warning",
        summary: "hono default config issue",
        fix: "pass syncFacilitatorOnStart: false",
      },
      {
        id: "python-skew",
        package: "python:x402",
        match: "any",
        severity: "blocking",
        summary: "Python SDK pre-v2 doesn't emit bazaar",
        fix: "refactor to TS v2",
      },
    ],
  };

  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "x402trace-audit-test-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns no_known_skew when local has no @x402 deps and service is healthy", async () => {
    const fetcher: typeof fetch = (async () =>
      new Response(JSON.stringify(VALID_CHALLENGE), { status: 402 })) as typeof fetch;
    const r = await runVersionsAudit({
      service: SERVICE,
      cwd: tmp,
      fetcher,
      knownSkew: TEST_SKEW,
    });
    expect(r.verdict).toBe("no_known_skew");
    expect(r.matches).toEqual([]);
  });

  it("matches an exact version (e.g. fetch 2.10.0)", async () => {
    await writeFile(
      join(tmp, "package.json"),
      JSON.stringify({ dependencies: { "@x402/fetch": "2.10.0" } }),
    );
    const fetcher: typeof fetch = (async () =>
      new Response(JSON.stringify(VALID_CHALLENGE), { status: 402 })) as typeof fetch;
    const r = await runVersionsAudit({
      service: SERVICE,
      cwd: tmp,
      fetcher,
      knownSkew: TEST_SKEW,
    });
    expect(r.verdict).toBe("skew_detected");
    expect(r.matches.map((m) => m.entry.id)).toContain("fetch-bug");
  });

  it("normalises semver-range prefixes (^2.10.0 still matches 2.10.0)", async () => {
    await writeFile(
      join(tmp, "package.json"),
      JSON.stringify({ dependencies: { "@x402/fetch": "^2.10.0" } }),
    );
    const fetcher: typeof fetch = (async () =>
      new Response(JSON.stringify(VALID_CHALLENGE), { status: 402 })) as typeof fetch;
    const r = await runVersionsAudit({
      service: SERVICE,
      cwd: tmp,
      fetcher,
      knownSkew: TEST_SKEW,
    });
    expect(r.matches.map((m) => m.entry.id)).toContain("fetch-bug");
  });

  it("does NOT match when the version is past the bug (e.g. 2.11.0)", async () => {
    await writeFile(
      join(tmp, "package.json"),
      JSON.stringify({ dependencies: { "@x402/fetch": "2.11.0" } }),
    );
    const fetcher: typeof fetch = (async () =>
      new Response(JSON.stringify(VALID_CHALLENGE), { status: 402 })) as typeof fetch;
    const r = await runVersionsAudit({
      service: SERVICE,
      cwd: tmp,
      fetcher,
      knownSkew: TEST_SKEW,
    });
    expect(r.matches.map((m) => m.entry.id)).not.toContain("fetch-bug");
  });

  it("matches an 'any' entry when the package is present at any version", async () => {
    await writeFile(
      join(tmp, "package.json"),
      JSON.stringify({ dependencies: { "@x402/hono": "2.12.0" } }),
    );
    const fetcher: typeof fetch = (async () =>
      new Response(JSON.stringify(VALID_CHALLENGE), { status: 402 })) as typeof fetch;
    const r = await runVersionsAudit({
      service: SERVICE,
      cwd: tmp,
      fetcher,
      knownSkew: TEST_SKEW,
    });
    expect(r.matches.map((m) => m.entry.id)).toContain("hono-default");
  });

  it("matches python: skew when no TS deps + service Server header indicates Python", async () => {
    // No package.json in tmp → no local @x402 deps detected.
    const fetcher: typeof fetch = (async () =>
      new Response(JSON.stringify(VALID_CHALLENGE), {
        status: 402,
        headers: { server: "uvicorn/0.24.0", "content-type": "application/json" },
      })) as typeof fetch;
    const r = await runVersionsAudit({
      service: SERVICE,
      cwd: tmp,
      fetcher,
      knownSkew: TEST_SKEW,
    });
    expect(r.matches.map((m) => m.entry.id)).toContain("python-skew");
  });

  it("does NOT match python: skew when local has TS @x402 deps (operator is on TS)", async () => {
    await writeFile(
      join(tmp, "package.json"),
      JSON.stringify({ dependencies: { "@x402/hono": "2.12.0" } }),
    );
    const fetcher: typeof fetch = (async () =>
      new Response(JSON.stringify(VALID_CHALLENGE), {
        status: 402,
        headers: { server: "uvicorn/0.24.0", "content-type": "application/json" },
      })) as typeof fetch;
    const r = await runVersionsAudit({
      service: SERVICE,
      cwd: tmp,
      fetcher,
      knownSkew: TEST_SKEW,
    });
    expect(r.matches.map((m) => m.entry.id)).not.toContain("python-skew");
  });

  it("captures the service Server header and x402Version into hints", async () => {
    const fetcher: typeof fetch = (async () =>
      new Response(JSON.stringify(VALID_CHALLENGE), {
        status: 402,
        headers: { server: "node/v22.0.0", "content-type": "application/json" },
      })) as typeof fetch;
    const r = await runVersionsAudit({
      service: SERVICE,
      cwd: tmp,
      fetcher,
      knownSkew: TEST_SKEW,
    });
    expect(r.serviceVersionHints["server"]).toBe("node/v22.0.0");
    expect(r.serviceVersionHints["x402Version"]).toBe(1);
  });

  it("survives a service fetch failure gracefully (local-only findings still emit)", async () => {
    await writeFile(
      join(tmp, "package.json"),
      JSON.stringify({ dependencies: { "@x402/fetch": "2.10.0" } }),
    );
    const fetcher: typeof fetch = (async () => {
      throw new Error("ENOTFOUND");
    }) as typeof fetch;
    const r = await runVersionsAudit({
      service: SERVICE,
      cwd: tmp,
      fetcher,
      knownSkew: TEST_SKEW,
    });
    expect(r.matches.map((m) => m.entry.id)).toContain("fetch-bug");
    expect(r.serviceVersionHints).toEqual({});
  });
});

describe("runVersionsCommand", () => {
  it("exits 1 (usage) when service is missing", async () => {
    const { ctx, err } = makeCtx();
    const code = await runVersionsCommand({}, ctx);
    expect(code).toBe(1);
    expect(err.output).toMatch(/required/);
  });

  it("exits 1 (usage) on invalid URL", async () => {
    const { ctx, err } = makeCtx();
    const code = await runVersionsCommand({ service: "not a url" }, ctx);
    expect(code).toBe(1);
    expect(err.output).toMatch(/valid URL/);
  });

  it("exits 0 + emits 'no known SDK skew' when nothing matches (using injected fetch + empty cwd)", async () => {
    const fetcher: typeof fetch = (async () =>
      new Response(JSON.stringify(VALID_CHALLENGE), { status: 402 })) as typeof fetch;
    const tmp = await mkdtemp(join(tmpdir(), "x402trace-cmd-test-"));
    try {
      const { ctx, out } = makeCtx({ fetch: fetcher });
      const code = await runVersionsCommand({ service: SERVICE, cwd: tmp }, ctx);
      expect(code).toBe(0);
      expect(out.output).toMatch(/no known SDK skew/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("exits 2 + emits skew_detected verdict when at least one match", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "x402trace-cmd-test-"));
    try {
      await writeFile(
        join(tmp, "package.json"),
        JSON.stringify({ dependencies: { "@x402/fetch": "2.10.0" } }),
      );
      const fetcher: typeof fetch = (async () =>
        new Response(JSON.stringify(VALID_CHALLENGE), { status: 402 })) as typeof fetch;
      const { ctx, out } = makeCtx({ fetch: fetcher });
      const code = await runVersionsCommand({ service: SERVICE, cwd: tmp }, ctx);
      expect(code).toBe(2);
      expect(out.output).toMatch(/skew_detected|2\.10\.0/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("emits a JSON line with verdict + matches when --log json", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "x402trace-cmd-test-"));
    try {
      await writeFile(
        join(tmp, "package.json"),
        JSON.stringify({ dependencies: { "@x402/fetch": "2.10.0" } }),
      );
      const fetcher: typeof fetch = (async () =>
        new Response(JSON.stringify(VALID_CHALLENGE), { status: 402 })) as typeof fetch;
      const { ctx, out } = makeCtx({ fetch: fetcher });
      await runVersionsCommand({ service: SERVICE, cwd: tmp, log: "json" }, ctx);
      const parsed = JSON.parse(out.output.trim());
      expect(parsed.verdict).toBe("skew_detected");
      expect(parsed.matches[0].entry.id).toBe("x402-fetch-2.10.0-extensions-echo");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
