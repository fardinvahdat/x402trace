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

import type { BazaarVerdict, CheckResult, IndexerState } from "./types.js";

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

export function synthesiseVerdict(results: readonly CheckResult[]): BazaarVerdict {
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
  if (upstreamSignals.length > 0 && hasProcessingIndexerState(results)) {
    return {
      kind: "upstream_stuck",
      exitCode: 3,
      message: `your implementation looks correct, but the Bazaar indexer is stuck on \`processing\` for this payTo. Settlements may have completed; the downstream indexing queue hasn't surfaced the service. Matches the canonical #2207 cluster (Max's polyodds.bet, 94+ reports). See https://github.com/x402-foundation/x402/issues/2207`,
      upstreamChecks: upstreamSignals.map((r) => r.check),
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
