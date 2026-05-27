/**
 * X402-46 (D.3) unit tests — shared facilitator detection helper.
 *
 * Manifest-claim-based detection per ADR-004 Pillar 3. Other detection
 * options (TomSmart's `facilitator_inferred`, empirical probe, hybrid)
 * are deferred to v0.3.4+.
 */
import { describe, expect, it } from "vitest";
import { detectFacilitator } from "../../src/bazaar/facilitator-detect.js";
import type { WellKnownManifest } from "../../src/bazaar/types.js";

function manifest(extensions?: Record<string, unknown>): WellKnownManifest {
  return {
    name: "X",
    description: "Y",
    ...(extensions !== undefined ? { extensions } : {}),
  };
}

describe("detectFacilitator", () => {
  it("returns 'unknown' when manifest is undefined (--endpoint mode)", () => {
    expect(detectFacilitator(undefined)).toBe("unknown");
  });

  it("returns 'unknown' when manifest has no extensions object", () => {
    expect(detectFacilitator(manifest())).toBe("unknown");
  });

  it("returns 'unknown' when extensions has no bazaar block", () => {
    expect(detectFacilitator(manifest({ someOther: {} }))).toBe("unknown");
  });

  it("returns 'unknown' when extensions.bazaar has no facilitator field", () => {
    expect(detectFacilitator(manifest({ bazaar: { name: "X" } }))).toBe("unknown");
  });

  it("returns 'unknown' when facilitator field is not a string", () => {
    expect(detectFacilitator(manifest({ bazaar: { facilitator: 42 } }))).toBe("unknown");
    expect(detectFacilitator(manifest({ bazaar: { facilitator: null } }))).toBe("unknown");
    expect(detectFacilitator(manifest({ bazaar: { facilitator: {} } }))).toBe("unknown");
  });

  it("returns 'unknown' when facilitator field is whitespace-only", () => {
    expect(detectFacilitator(manifest({ bazaar: { facilitator: "" } }))).toBe("unknown");
    expect(detectFacilitator(manifest({ bazaar: { facilitator: "   " } }))).toBe("unknown");
  });

  it("returns 'cdp' for the recognised CDP claim values (case-insensitive)", () => {
    expect(detectFacilitator(manifest({ bazaar: { facilitator: "coinbase-cdp" } }))).toBe("cdp");
    expect(detectFacilitator(manifest({ bazaar: { facilitator: "Coinbase-CDP" } }))).toBe("cdp");
    expect(detectFacilitator(manifest({ bazaar: { facilitator: "cdp" } }))).toBe("cdp");
    expect(detectFacilitator(manifest({ bazaar: { facilitator: "CDP" } }))).toBe("cdp");
    expect(detectFacilitator(manifest({ bazaar: { facilitator: "coinbase" } }))).toBe("cdp");
    expect(detectFacilitator(manifest({ bazaar: { facilitator: "  Coinbase  " } }))).toBe("cdp");
  });

  it("returns 'non-cdp' for any other non-empty string value", () => {
    expect(detectFacilitator(manifest({ bazaar: { facilitator: "x402-rs" } }))).toBe("non-cdp");
    expect(detectFacilitator(manifest({ bazaar: { facilitator: "self-hosted" } }))).toBe("non-cdp");
    expect(detectFacilitator(manifest({ bazaar: { facilitator: "xpay" } }))).toBe("non-cdp");
    expect(detectFacilitator(manifest({ bazaar: { facilitator: "anchor-x402-jpyc" } }))).toBe(
      "non-cdp",
    );
  });
});
