/**
 * X402-32 — verdict synthesizer.
 *
 * Reduces N per-check `CheckResult`s into a single bottom-line answer:
 *
 *   - `looks_correct`        (exit 0): all checks pass (incl. non-CDP
 *                                       services declaring
 *                                       `not_applicable_non_cdp` on
 *                                       indexing + propagation).
 *   - `implementation_issue` (exit 2): at least one `fail` in
 *                                       implementation-side checks
 *                                       (well-known, challenge,
 *                                       self-payment).
 *   - `upstream_stuck`       (exit 3): facilitator settled, but the
 *                                       indexer is stuck on
 *                                       `processing` (X402-46 / D.3).
 *                                       Max's polyodds.bet case +
 *                                       the canonical #2207 cluster.
 *   - `upstream_issue`       (exit 3): no implementation fails, no
 *                                       indexer-stuck signal, but
 *                                       generic upstream info (e.g.
 *                                       propagation drift, network
 *                                       error on indexer query).
 *
 * Per ADR-004 Pillar 1, `upstream_stuck` rolls up to exit code 3 —
 * verdict prose + JSON facets carry the granularity, exit-code surface
 * stays a 3-value contract.
 *
 * The verdict prose names the canonical upstream issue when applicable
 * (#2207) so operators don't have to map the symptom to the GitHub
 * ticket themselves.
 */

import type {
  BazaarVerdict,
  CheckResult,
  IndexerState,
  PaymentPayloadCapture,
  SettleResponseCapture,
  UpstreamStuckCause,
} from "./types.js";
import { evaluatePaymentPayloadEchoGap } from "./payment-payload-rules.js";

const IMPLEMENTATION_CHECKS = new Set(["well-known", "challenge", "self-payment"]);
const UPSTREAM_CHECKS = new Set(["indexing", "propagation"]);

/**
 * Detect whether the indexing check fired `indexer_state: processing`,
 * the signal that distinguishes `upstream_stuck` from generic
 * `upstream_issue` per ADR-004 Pillar 1.
 */
function hasProcessingIndexerState(results: readonly CheckResult[]): boolean {
  const indexing = results.find((r) => r.check === "indexing");
  if (!indexing) return false;
  const indexerState = indexing.detail?.["indexer_state"] as IndexerState | undefined;
  return indexerState === "processing";
}

/**
 * X402-50 (K, ADR-007) — compute the `upstream_stuck_cause` discriminator
 * given the check results + optional K-rule capture data.
 *
 * Precedence (per ADR-007):
 *   1. `payload_echo_gap` if either K rule fired.
 *   2. `unknown` (capture-checked sentinel) when K capture data WAS
 *      supplied for **both** Rule 1 (payment payload) and Rule 2
 *      (settle response) AND both rules returned false. This is the
 *      @AsaiShota contrast case: payload-correct, extensions echoed,
 *      still stuck — we have the data to rule K out, so attributing
 *      to a narrower cause would over-claim. Going to `unknown` is
 *      more honest.
 *   3. `indexer_state_processing` if K capture was NOT fully supplied
 *      AND the indexing check classified the indexer state as
 *      `processing`. This is the v0.3.2 baseline path (the d3 /
 *      pre-K legacy fixtures); the indexer-state is the best signal
 *      we have without capture data.
 *   4. `unknown` otherwise — anything else, default conservative.
 *
 * The `indexer_state_terminal` type slot is reserved for a future
 * refinement of the IndexerState enum (per ADR-007 "deferred" note);
 * v0.3.4 K's MVP doesn't distinguish processing-fresh vs
 * processing-stale (requires settle-timestamp data x402trace doesn't
 * collect standalone today).
 */
function computeUpstreamStuckCause(
  results: readonly CheckResult[],
  opts: {
    paymentPayloadCapture?: PaymentPayloadCapture;
    settleCapture?: SettleResponseCapture;
    challengeExtensions?: unknown;
  },
): UpstreamStuckCause {
  const kRule = evaluatePaymentPayloadEchoGap({
    paymentPayloadCapture: opts.paymentPayloadCapture,
    settleCapture: opts.settleCapture,
    challengeExtensions: opts.challengeExtensions,
  });
  if (kRule.fired) {
    return "payload_echo_gap";
  }
  // Capture-checked sentinel: both K rules ran (not null) and both
  // returned false. We have the data to confirm it's not K; surface
  // as `unknown` rather than mis-attributing to indexer state.
  const r1Checked = kRule.rule1_missing_resource_object !== null;
  const r2Checked = kRule.rule2_extensions_not_echoed !== null;
  if (r1Checked && r2Checked) {
    return "unknown";
  }
  if (hasProcessingIndexerState(results)) {
    return "indexer_state_processing";
  }
  return "unknown";
}

/**
 * Extract the challenge body's `extensions` block from check results.
 * Used by `computeUpstreamStuckCause` for Rule 2's challenge-side
 * declared-non-empty check.
 *
 * Returns `undefined` when the challenge check failed or has no
 * structural detail to extract from. K rules treat this as "no
 * declaration available" → Rule 2 cannot fire.
 */
function challengeExtensionsFrom(results: readonly CheckResult[]): unknown {
  const challenge = results.find((r) => r.check === "challenge");
  if (!challenge || challenge.status === "fail") return undefined;
  // The challenge check's `detail` carries variant + missingFields on
  // fail paths; on pass paths the extensions object itself is not
  // surfaced. We expose it via a dedicated `challengeExtensions` detail
  // key that the orchestrator populates on the pass path (see
  // src/bazaar/index.ts) so the verdict synthesizer can read it without
  // re-parsing the raw 402 body.
  return challenge.detail?.["challengeExtensions"];
}

/**
 * Optional K-rule capture inputs threaded through from
 * `BazaarCheckOptions` in `index.ts`. Both fields default to
 * undefined — when absent, the K rules defer and the verdict
 * synthesizer's `upstream_stuck_cause` falls back to
 * indexer-state-derived or `unknown` (see `computeUpstreamStuckCause`).
 */
export interface SynthesiseVerdictOptions {
  readonly paymentPayloadCapture?: PaymentPayloadCapture;
  readonly settleCapture?: SettleResponseCapture;
}

export function synthesiseVerdict(
  results: readonly CheckResult[],
  opts: SynthesiseVerdictOptions = {},
): BazaarVerdict {
  const implementationFails = results.filter(
    (r) => r.status === "fail" && IMPLEMENTATION_CHECKS.has(r.check),
  );
  if (implementationFails.length > 0) {
    return {
      kind: "implementation_issue",
      exitCode: 2,
      message: `found ${implementationFails.length} issue(s) in your implementation. Fix the failed check(s) before shipping to Bazaar.`,
      failedChecks: implementationFails.map((r) => r.check),
    };
  }

  const upstreamSignals = results.filter(
    (r) => r.status === "info" && UPSTREAM_CHECKS.has(r.check),
  );

  // X402-46 (D.3) — when the upstream signal is specifically an
  // indexer stuck on `processing`, surface as `upstream_stuck` so
  // operators know the root cause (facilitator settled, indexer
  // queue stalled — Max's case). Distinct from generic upstream
  // signals like propagation field drift.
  //
  // X402-50 (K, ADR-007) — additionally compute the `cause`
  // discriminator: payload_echo_gap > indexer_state_processing > unknown.
  if (upstreamSignals.length > 0 && hasProcessingIndexerState(results)) {
    const cause = computeUpstreamStuckCause(results, {
      ...(opts.paymentPayloadCapture !== undefined
        ? { paymentPayloadCapture: opts.paymentPayloadCapture }
        : {}),
      ...(opts.settleCapture !== undefined ? { settleCapture: opts.settleCapture } : {}),
      challengeExtensions: challengeExtensionsFrom(results),
    });
    return {
      kind: "upstream_stuck",
      exitCode: 3,
      message: `your implementation looks correct, but the Bazaar indexer is stuck on \`processing\` for this payTo. Settlements may have completed; the downstream indexing queue hasn't surfaced the service. Matches the canonical #2207 cluster (Max's polyodds.bet, 94+ reports). See https://github.com/x402-foundation/x402/issues/2207`,
      upstreamChecks: upstreamSignals.map((r) => r.check),
      cause,
    };
  }

  if (upstreamSignals.length > 0) {
    return {
      kind: "upstream_issue",
      exitCode: 3,
      message: `your implementation looks correct, but an upstream Bazaar issue is gating discovery. The most common cause is the canonical #2207 (CDP facilitator does not return EXTENSION-RESPONSES header). See https://github.com/x402-foundation/x402/issues/2207`,
      upstreamChecks: upstreamSignals.map((r) => r.check),
    };
  }

  return {
    kind: "looks_correct",
    exitCode: 0,
    message:
      "all checks pass. Your bazaar integration looks correct; if you're seeing a Bazaar indexing delay, give CDP 24-48h before assuming a problem.",
  };
}
