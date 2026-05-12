import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlSink } from "../../src/proxy/jsonl-sink.js";

describe("JsonlSink", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "x402trace-jsonl-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes one JSON object per line, append-only, terminated by \\n", async () => {
    const path = join(dir, "events.jsonl");
    const sink = new JsonlSink(path);
    await sink.open();
    sink.append({ a: 1, b: "two" });
    sink.append({ a: 2, b: "three" });
    await sink.close();

    const contents = await readFile(path, "utf8");
    expect(contents).toBe(`{"a":1,"b":"two"}\n{"a":2,"b":"three"}\n`);
  });

  it("creates parent directories if missing", async () => {
    const path = join(dir, "nested", "deeper", "events.jsonl");
    const sink = new JsonlSink(path);
    await sink.open();
    sink.append({ ok: true });
    await sink.close();

    const contents = await readFile(path, "utf8");
    expect(contents).toBe(`{"ok":true}\n`);
  });

  it("appends to an existing file without truncating", async () => {
    const path = join(dir, "events.jsonl");
    const a = new JsonlSink(path);
    await a.open();
    a.append({ id: 1 });
    await a.close();

    const b = new JsonlSink(path);
    await b.open();
    b.append({ id: 2 });
    await b.close();

    const contents = await readFile(path, "utf8");
    expect(contents).toBe(`{"id":1}\n{"id":2}\n`);
  });

  it("throws if append() is called before open()", () => {
    const sink = new JsonlSink(join(dir, "x.jsonl"));
    expect(() => sink.append({ x: 1 })).toThrow(/open\(\) must be called/);
  });

  it("close() is idempotent", async () => {
    const path = join(dir, "events.jsonl");
    const sink = new JsonlSink(path);
    await sink.open();
    sink.append({ ok: true });
    await sink.close();
    await expect(sink.close()).resolves.toBeUndefined();
  });
});
