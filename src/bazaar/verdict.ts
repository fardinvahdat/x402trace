/**
 * X402-32 — verdict synthesizer.
 *
 * Reduces N per-check `CheckResult`s into a single bottom-line answer:
 *
 *   - `looks_correct`        (exit 0): all checks pass.
 *   - `implementation_issue` (exit 2): at least one `fail` in
 *                                       implementation-side checks
 *                                       (well-known, challenge,
 *                                       self-payment).
 *   - `upstream_issue`       (exit 3): no implementation fails, but at
 *                                       least one upstream-bound `info`
 *                                       signal (e.g. indexing returned
 *                                       0 resources after settle).
 *
 * The verdict prose names the canonical upstream issue when applicable
 * (#2207) so operators don't have to map the symptom to the GitHub
 * ticket themselves.
 */

import type { BazaarVerdict, CheckResult } from "./types.js";

const IMPLEMENTATION_CHECKS = new Set(["well-known", "challenge", "self-payment"]);
const UPSTREAM_CHECKS = new Set(["indexing", "propagation"]);

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
