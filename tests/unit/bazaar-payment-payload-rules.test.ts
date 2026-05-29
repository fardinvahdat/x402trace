/**
 * X402-50 (v0.3.4 K, ADR-007) — payment-payload echo gap rule pair tests.
 *
 * Covers Rule 1 (`payment_payload_missing_resource_object`) + Rule 2
 * (`extensions_not_echoed`) + the aggregator. Rules are pure functions;
 * no fetch mocking required at this layer.
 *
 * The integration test layer
 * (`tests/integration/bazaar-check-captured-responses.test.ts`)
 * exercises the same rules via the captured-response fixture harness
 * + `synthesiseVerdict`'s `cause` computation.
 */

import { describe, expect, it } from "vitest";
import {
  evaluateExtensionsNotEchoed,
  evaluateMissingResourceObject,
  evaluatePaymentPayloadEchoGap,
} from "../../src/bazaar/payment-payload-rules.js";

describe("Rule 1 — payment_payload_missing_resource_object", () => {
  it("defers (returns null) when no capture supplied", () => {
    expect(evaluateMissingResourceObject(undefined)).toBeNull();
  });

  it("fires when resource is a bare URL string", () => {
    const result = evaluateMissingResourceObject({
      paymentPayload: {
        scheme: "exact",
        network: "eip155:8453",
        resource: "https://api.example.com/v1/anchor",
      },
    });
    expect(result).toBe(true);
  });

  it("does NOT fire when resource is a well-formed object", () => {
    const result = evaluateMissingResourceObject({
      paymentPayload: {
        scheme: "exact",
        network: "eip155:8453",
        resource: {
          url: "https://api.example.com/v1/anchor",
          description: "Anchor endpoint",
          mimeType: "application/json",
        },
      },
    });
    expect(result).toBe(false);
  });

  it("does NOT fire when resource is absent (different gap shape)", () => {
    const result = evaluateMissingResourceObject({
      paymentPayload: { scheme: "exact", network: "eip155:8453" },
    });
    expect(result).toBe(false);
  });

  it("defers when paymentPayload is not an object", () => {
    // Captures from a buggy proxy can deliver malformed shapes; the
    // rule treats that as "no diagnosable data" rather than firing.
    const result = evaluateMissingResourceObject({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      paymentPayload: null as any,
    });
    expect(result).toBeNull();
  });

  it("contrast case: AsaiShota-style payload (resource object correct, still stuck)", () => {
    // Documents the false-positive guard: payload-shape-correct
    // services that remain stuck must NOT route to payload_echo_gap.
    // Rule 1 returns false (rule did not fire); the aggregator
    // returns `fired: false`; cause stays `unknown`.
    const result = evaluateMissingResourceObject({
      paymentPayload: {
        resource: {
          url: "https://x402-market-api.lien-studio-akiyama.workers.dev/api/seller-4068b8fc/test-echo-cdp",
          description: "Echo endpoint with extensions",
          mimeType: "application/json",
        },
        extensions: { bazaar: { name: "test-echo-cdp", description: "AsaiShota's test surface" } },
      },
    });
    expect(result).toBe(false);
  });
});

describe("Rule 2 — extensions_not_echoed", () => {
  it("defers when no settle capture supplied", () => {
    expect(evaluateExtensionsNotEchoed(undefined, { bazaar: { name: "x" } })).toBeNull();
  });

  it("does NOT fire on non-2xx settle responses (defers to different failure class)", () => {
    const result = evaluateExtensionsNotEchoed(
      { status: 500, headers: { "extension-responses": "e30=" } },
      { bazaar: { name: "x" } },
    );
    expect(result).toBe(false);
  });

  it("fires on the canonical signature: e30= + non-empty challenge extensions", () => {
    const result = evaluateExtensionsNotEchoed(
      { status: 200, headers: { "extension-responses": "e30=" } },
      { bazaar: { name: "AgentOracle", description: "research API" } },
    );
    expect(result).toBe(true);
  });

  it("does NOT fire when challenge extensions are absent (bazaar-disabled service)", () => {
    // The empty-`{}` alone is not enough — bazaar-disabled paths
    // legitimately produce `{}`; the challenge-side non-empty
    // declaration is what makes the gap diagnosable. Without a
    // declaration, the rule is undefined and must not fire.
    const result = evaluateExtensionsNotEchoed(
      { status: 200, headers: { "extension-responses": "e30=" } },
      undefined,
    );
    expect(result).toBe(false);
  });

  it("does NOT fire when challenge extensions object is empty", () => {
    const result = evaluateExtensionsNotEchoed(
      { status: 200, headers: { "extension-responses": "e30=" } },
      {},
    );
    expect(result).toBe(false);
  });

  it("does NOT fire when EXTENSION-RESPONSES header is absent", () => {
    const result = evaluateExtensionsNotEchoed(
      { status: 200, headers: { "content-type": "application/json" } },
      { bazaar: { name: "x" } },
    );
    expect(result).toBe(false);
  });

  it("does NOT fire when EXTENSION-RESPONSES is a non-empty echo (extensions present in response)", () => {
    // Properly-echoed extensions surface here as base64 of the echoed
    // object; not "e30=" (which is `{}`). Rule should not fire.
    const result = evaluateExtensionsNotEchoed(
      {
        status: 200,
        headers: { "extension-responses": "eyJiYXphYXIiOnsiaW5kZXgiOiJwcm9jZXNzaW5nIn19" },
      },
      { bazaar: { name: "x" } },
    );
    expect(result).toBe(false);
  });

  it("tolerates surrounding whitespace on the header value", () => {
    const result = evaluateExtensionsNotEchoed(
      { status: 200, headers: { "extension-responses": "  e30=  " } },
      { bazaar: { name: "x" } },
    );
    expect(result).toBe(true);
  });

  it("contrast case: AsaiShota-style — challenge declares extensions, but signature does NOT appear", () => {
    // AsaiShota's test-echo-cdp ships both fixes; settle response has
    // proper echoed extensions, not the `e30=` signature. Rule does
    // not fire.
    const result = evaluateExtensionsNotEchoed(
      {
        status: 200,
        headers: { "extension-responses": "eyJiYXphYXIiOnsic3RhdHVzIjoicHJvY2Vzc2luZyJ9fQ==" },
      },
      { bazaar: { name: "test-echo-cdp", description: "AsaiShota's surface" } },
    );
    expect(result).toBe(false);
  });
});

describe("evaluatePaymentPayloadEchoGap — aggregator", () => {
  it("does not fire when no capture is supplied (both rules defer)", () => {
    const result = evaluatePaymentPayloadEchoGap({});
    expect(result.fired).toBe(false);
    expect(result.rule1_missing_resource_object).toBeNull();
    expect(result.rule2_extensions_not_echoed).toBeNull();
    expect(result.signals).toEqual({});
  });

  it("fires when Rule 1 fires alone", () => {
    const result = evaluatePaymentPayloadEchoGap({
      paymentPayloadCapture: {
        paymentPayload: { resource: "https://api.example.com/v1/x" },
      },
    });
    expect(result.fired).toBe(true);
    expect(result.rule1_missing_resource_object).toBe(true);
    expect(result.rule2_extensions_not_echoed).toBeNull();
    expect(result.signals).toHaveProperty("rule1_missing_resource_object");
    expect(result.signals).not.toHaveProperty("rule2_extensions_not_echoed");
  });

  it("fires when Rule 2 fires alone", () => {
    const result = evaluatePaymentPayloadEchoGap({
      settleCapture: { status: 200, headers: { "extension-responses": "e30=" } },
      challengeExtensions: { bazaar: { name: "x" } },
    });
    expect(result.fired).toBe(true);
    expect(result.rule1_missing_resource_object).toBeNull();
    expect(result.rule2_extensions_not_echoed).toBe(true);
    expect(result.signals).toHaveProperty("rule2_extensions_not_echoed");
  });

  it("fires when both rules fire", () => {
    const result = evaluatePaymentPayloadEchoGap({
      paymentPayloadCapture: { paymentPayload: { resource: "https://api.example.com/v1/x" } },
      settleCapture: { status: 200, headers: { "extension-responses": "e30=" } },
      challengeExtensions: { bazaar: { name: "x" } },
    });
    expect(result.fired).toBe(true);
    expect(result.rule1_missing_resource_object).toBe(true);
    expect(result.rule2_extensions_not_echoed).toBe(true);
    expect(Object.keys(result.signals)).toHaveLength(2);
  });

  it("AsaiShota contrast case: capture supplied, both rules return false, aggregator does not fire", () => {
    // Payload-shape-correct + extensions properly echoed = no gap.
    // This is the false-positive sentinel from ADR-007's risk #1.
    const result = evaluatePaymentPayloadEchoGap({
      paymentPayloadCapture: {
        paymentPayload: {
          resource: {
            url: "https://x402-market-api.lien-studio-akiyama.workers.dev/test-echo-cdp",
            description: "echo",
          },
          extensions: { bazaar: { name: "test-echo-cdp" } },
        },
      },
      settleCapture: {
        status: 200,
        headers: { "extension-responses": "eyJiYXphYXIiOnsic3RhdHVzIjoicHJvY2Vzc2luZyJ9fQ==" },
      },
      challengeExtensions: { bazaar: { name: "test-echo-cdp" } },
    });
    expect(result.fired).toBe(false);
    expect(result.rule1_missing_resource_object).toBe(false);
    expect(result.rule2_extensions_not_echoed).toBe(false);
  });

  it("signals carry remediation text for each rule that fires", () => {
    const result = evaluatePaymentPayloadEchoGap({
      paymentPayloadCapture: { paymentPayload: { resource: "https://api.example.com/v1/x" } },
      settleCapture: { status: 200, headers: { "extension-responses": "e30=" } },
      challengeExtensions: { bazaar: { name: "x" } },
    });
    const r1 = result.signals["rule1_missing_resource_object"] as Record<string, unknown>;
    const r2 = result.signals["rule2_extensions_not_echoed"] as Record<string, unknown>;
    expect(r1["remediation"]).toContain("resource");
    expect(r2["remediation"]).toContain("extensions");
  });
});
