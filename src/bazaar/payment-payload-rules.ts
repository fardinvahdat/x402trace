/**
 * X402-50 (v0.3.4 K, ADR-007) — payment-payload echo gap diagnose rules.
 *
 * Two rules refine the `upstream_stuck` verdict (introduced in v0.3.2 D.3
 * / X402-46 / ADR-004 Pillar 1) with attribution to a specific root
 * cause: the buyer-side wrapper omits one of two payload fields that
 * CDP's Bazaar indexer requires, so the listing silently never lands.
 *
 * Canonical writeup: @RipperMercs in x402-foundation/x402#2207
 * 2026-05-26 (TensorFeed went 1→29 indexed in <1hr for $0.52 of test
 * settles after shipping both fixes server-side). Reference impl:
 * https://github.com/RipperMercs/tensorfeed/blob/main/worker/src/cdp-facilitator.ts.
 * Corroboration: @TKCollective (AgentOracle) 44-line patch in
 * commit 71272948, indexed 22min post-fix.
 *
 * The two missing fields (per `PaymentPayloadV2Schema` in
 * `@x402/core@2.11.0` `schemas/index.d.mts:315-389`):
 *
 *   1. `paymentPayload.resource` must be a `{url, description?, mimeType?}`
 *      object, not a bare URL string. A bare string returns CDP HTTP 400
 *      `'paymentPayload' is invalid` and skips bazaar processing.
 *   2. `paymentPayload.extensions` must be echoed verbatim from the 402
 *      challenge. Without this, CDP emits the canonical
 *      `EXTENSION-RESPONSES: e30=` (base64 `{}`) signature on /settle
 *      and skips bazaar processing.
 *
 * **Capture-required by design.** Both rules need data that
 * `bazaar-check` standalone does not collect — Rule 1 needs the
 * buyer's signed `paymentPayload`; Rule 2 needs the /settle response
 * headers. In standalone mode, both rules defer (`fired: false`);
 * the verdict synthesizer falls back to indexer-state-derived causes
 * or `unknown`. Proxy / fixture-replay mode supplies the data via
 * `BazaarCheckOptions.paymentPayloadCapture` + `settleCapture`.
 *
 * Output: which sub-rules fired, plus diagnostic signals for the
 * `detail.payload_echo_gap_signals` facet. The verdict-side
 * `upstream_stuck_cause` discriminator is computed by
 * `synthesiseVerdict` based on whether `fired === true`.
 *
 * **Contrast voice (false-positive guard).** @AsaiShota's
 * test-echo-cdp ships both enrichments correctly but remains stuck
 * in `/discovery` since 2026-05-11. The rules must NOT mis-classify
 * this case as `payload_echo_gap` — when the buyer-side fields are
 * present and well-formed, Rule 1 and Rule 2 both return `fired: false`
 * and the cause stays `unknown`.
 */

import type { PaymentPayloadCapture, SettleResponseCapture } from "./types.js";

/**
 * Result of evaluating the K rule pair. The `fired` flag drives the
 * `upstream_stuck_cause: payload_echo_gap` verdict synthesis; the
 * `signals` payload surfaces under `detail.payload_echo_gap_signals`
 * for downstream JSON consumers + the human-format renderer.
 */
export interface PaymentPayloadEchoGapResult {
  /** True iff Rule 1 OR Rule 2 fired. */
  readonly fired: boolean;
  /** Per-rule firing state. `null` means "deferred — capture data unavailable". */
  readonly rule1_missing_resource_object: boolean | null;
  readonly rule2_extensions_not_echoed: boolean | null;
  /** Optional human-readable diagnostic for each rule that fired. */
  readonly signals: Readonly<Record<string, unknown>>;
}

/**
 * Rule 1: `payment_payload_missing_resource_object`.
 *
 * Fires when `paymentPayload.resource` is a bare URL string instead
 * of a `{url, description?, mimeType?}` object. Deterministic: the
 * type check is bit-for-bit identifiable from the captured payload.
 *
 * Returns:
 *   - `null` when no capture available (defer; can't evaluate)
 *   - `true` when capture has `resource` as a string (gap confirmed)
 *   - `false` when capture has `resource` as a well-formed object
 *     (or absent altogether — absence isn't this rule's signal)
 */
export function evaluateMissingResourceObject(
  capture: PaymentPayloadCapture | undefined,
): boolean | null {
  if (!capture) return null;
  const payload = capture.paymentPayload;
  if (typeof payload !== "object" || payload === null) return null;
  const resource = (payload as Record<string, unknown>)["resource"];
  if (resource === undefined) {
    // `resource` not present at all — not the bare-string failure
    // mode this rule targets. Different gap shape; rule does not
    // fire (caller may surface via a separate rule later).
    return false;
  }
  return typeof resource === "string";
}

/**
 * Rule 2: `extensions_not_echoed`.
 *
 * Fires when both:
 *   1. The /settle response carries `EXTENSION-RESPONSES: e30=`
 *      (base64 for `{}` — the canonical "extensions absent in
 *      response" signature documented in #2207); and
 *   2. The upstream 402 challenge declared a non-empty
 *      `extensions` block.
 *
 * Both conditions are load-bearing. The `e30=` signature alone is
 * not enough — bazaar-disabled services legitimately return `{}`
 * on /settle. The challenge-side non-empty declaration is what
 * makes the gap diagnosable as "bazaar opted in but the extensions
 * weren't echoed back."
 *
 * Returns:
 *   - `null` when no settle capture available (defer)
 *   - `true` when both conditions hold
 *   - `false` otherwise
 */
export function evaluateExtensionsNotEchoed(
  settle: SettleResponseCapture | undefined,
  challengeExtensions: unknown,
): boolean | null {
  if (!settle) return null;
  if (settle.status < 200 || settle.status >= 300) {
    // Non-2xx settle — different failure class, this rule defers.
    return false;
  }
  // Look up the header case-insensitively; capture types use lowercased keys.
  const extensionResponses = settle.headers["extension-responses"];
  if (typeof extensionResponses !== "string") return false;
  if (extensionResponses.trim() !== "e30=") return false;

  // Second condition: challenge declared non-empty `extensions`.
  if (typeof challengeExtensions !== "object" || challengeExtensions === null) {
    return false;
  }
  if (Object.keys(challengeExtensions as Record<string, unknown>).length === 0) {
    return false;
  }
  return true;
}

/**
 * Compose the rule pair into the K-rule diagnostic. The two rules
 * run independently; the result aggregates their state into a single
 * "fired or not" flag for the verdict synthesizer.
 *
 * Per ADR-007: Rule 1 needs `paymentPayloadCapture`, Rule 2 needs
 * `settleCapture` plus the parsed challenge body's `extensions` block.
 * Either can be supplied without the other; the aggregator handles
 * partial-capture scenarios sanely.
 */
export function evaluatePaymentPayloadEchoGap(opts: {
  readonly paymentPayloadCapture?: PaymentPayloadCapture;
  readonly settleCapture?: SettleResponseCapture;
  readonly challengeExtensions?: unknown;
}): PaymentPayloadEchoGapResult {
  const rule1 = evaluateMissingResourceObject(opts.paymentPayloadCapture);
  const rule2 = evaluateExtensionsNotEchoed(opts.settleCapture, opts.challengeExtensions);

  const signals: Record<string, unknown> = {};
  if (rule1 === true) {
    signals["rule1_missing_resource_object"] = {
      // Capture available + checked, gap confirmed
      observed_resource_type: "string",
      expected_resource_type: "object",
      remediation:
        "set paymentPayload.resource = { url: '<resource-url>', description?, mimeType? } object on buyer-side payload before signing. Bare URL string returns CDP 400 invalid_payload.",
    };
  }
  if (rule2 === true) {
    signals["rule2_extensions_not_echoed"] = {
      settle_extension_responses: "e30=",
      challenge_extensions_declared: true,
      remediation:
        "echo paymentPayload.extensions verbatim from the 402 challenge body before signing. CDP needs this to route the settle to its Bazaar indexer.",
    };
  }

  return {
    fired: rule1 === true || rule2 === true,
    rule1_missing_resource_object: rule1,
    rule2_extensions_not_echoed: rule2,
    signals,
  };
}
