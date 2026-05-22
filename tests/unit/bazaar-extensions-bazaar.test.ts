/**
 * X402-43 (D.5) — variant-aware extensions.bazaar helper unit tests.
 *
 * Tests the variant detection + validation logic in isolation, before
 * its callers (challenge.ts, well-known.ts) consume it.
 */
import { describe, expect, it } from "vitest";
import {
  detectBazaarVariant,
  validateBazaarExtension,
} from "../../src/bazaar/extensions-bazaar.js";

describe("detectBazaarVariant", () => {
  it("returns 'unknown' for non-object inputs", () => {
    expect(detectBazaarVariant(undefined)).toBe("unknown");
    expect(detectBazaarVariant(null)).toBe("unknown");
    expect(detectBazaarVariant("not an object")).toBe("unknown");
    expect(detectBazaarVariant(42)).toBe("unknown");
  });

  it("returns 'body-discovery' when info.input + info.output + schema all present", () => {
    expect(
      detectBazaarVariant({
        info: { input: { type: "object" }, output: { type: "object" } },
        schema: { fields: [] },
      }),
    ).toBe("body-discovery");
  });

  it("returns 'mcp-discovery' as the default fallback for objects without body-discovery shape (ADR-004 'else assume Mcp')", () => {
    // Empty object — no body indicators, default to mcp
    expect(detectBazaarVariant({})).toBe("mcp-discovery");
    // Mcp-shaped object
    expect(detectBazaarVariant({ name: "X", description: "Y" })).toBe("mcp-discovery");
    // Object with foreign fields — still mcp by default
    expect(detectBazaarVariant({ category: "data" })).toBe("mcp-discovery");
  });

  it("returns 'body-discovery' even when name/description are also present (body indicators win)", () => {
    expect(
      detectBazaarVariant({
        name: "Hybrid",
        description: "Both shapes present",
        info: { input: {}, output: {} },
        schema: {},
      }),
    ).toBe("body-discovery");
  });

  it("returns 'mcp-discovery' when info is present but missing input or output or schema", () => {
    // Missing schema
    expect(
      detectBazaarVariant({
        info: { input: {}, output: {} },
      }),
    ).toBe("mcp-discovery");
    // Missing info.output
    expect(
      detectBazaarVariant({
        info: { input: {} },
        schema: {},
      }),
    ).toBe("mcp-discovery");
    // info is not an object
    expect(detectBazaarVariant({ info: "string", schema: {} })).toBe("mcp-discovery");
  });
});

describe("validateBazaarExtension — mcp-discovery variant", () => {
  it("passes on a well-formed mcp-discovery bazaar object", () => {
    const r = validateBazaarExtension({ name: "Catalog API", description: "Esim providers" });
    expect(r.variant).toBe("mcp-discovery");
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("fails with both fields missing when bazaar is an empty object", () => {
    const r = validateBazaarExtension({});
    expect(r.variant).toBe("mcp-discovery");
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(expect.arrayContaining(["name", "description"]));
    expect(r.missing).toHaveLength(2);
  });

  it("fails when name is missing or whitespace-only", () => {
    const r = validateBazaarExtension({ name: "   ", description: "ok" });
    expect(r.variant).toBe("mcp-discovery");
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["name"]);
  });
});

describe("validateBazaarExtension — body-discovery variant", () => {
  function bodyDiscovery(overrides: Record<string, unknown> = {}): unknown {
    return {
      info: {
        input: { type: "object", properties: { q: { type: "string" } } },
        output: { type: "object", properties: { result: { type: "string" } } },
      },
      schema: { version: 1 },
      ...overrides,
    };
  }

  it("passes on a well-formed body-discovery bazaar object", () => {
    const r = validateBazaarExtension(bodyDiscovery());
    expect(r.variant).toBe("body-discovery");
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("fails when info.output is missing", () => {
    const r = validateBazaarExtension({
      info: { input: {} },
      schema: {},
    });
    // This case has no info.output and no schema field shape match -> body? No,
    // missing schema means detection falls back to mcp. Verify:
    expect(r.variant).toBe("mcp-discovery");
    // Now test a real body-discovery case where info exists but output is not an object
    const r2 = validateBazaarExtension({
      info: { input: {}, output: "not-object" },
      schema: {},
    });
    expect(r2.variant).toBe("body-discovery");
    expect(r2.ok).toBe(false);
    expect(r2.missing).toEqual(["info.output"]);
  });

  it("fails when schema is not an object", () => {
    const r = validateBazaarExtension({
      info: { input: {}, output: {} },
      schema: "not an object but the key is present",
    });
    expect(r.variant).toBe("body-discovery");
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["schema"]);
  });

  it("reports multiple body-discovery missing fields in one pass", () => {
    const r = validateBazaarExtension({
      info: { input: null, output: null },
      schema: 42,
    });
    expect(r.variant).toBe("body-discovery");
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(expect.arrayContaining(["info.input", "info.output", "schema"]));
    expect(r.missing).toHaveLength(3);
  });
});

describe("validateBazaarExtension — unknown variant (defensive)", () => {
  it("returns ok=true and skips validation for non-object inputs", () => {
    const r = validateBazaarExtension(undefined);
    expect(r.variant).toBe("unknown");
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });
});
