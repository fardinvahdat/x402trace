/**
 * X402-32 — bazaar-check orchestration.
 *
 * Composes the four checks (well-known, challenge, self-payment,
 * indexing) into a single report. Each check runs independently with
 * its own fetcher injection so unit tests stay hermetic and the
 * integration test can wire a single fetcher across all four.
 *
 * **v0.3 scope cut:** the paid-pass mode (`--with-wallet`) mentioned in
 * the Jira AC is deferred to v0.3.1. The bazaar-check shipped here is
 * static-analysis only — it does NOT submit a signed payment. The
 * EXTENSION-RESPONSES missing detection (via X402-33's
 * `extensionResponsesMissingRule`) fires only when a future caller
 * actually drives the settle path and surfaces the response headers.
 * See the X402-32 audit log for the rationale.
 */

import { checkChallenge, fetchChallenge, checkSelfPayment } from "./challenge.js";
import { checkIndexing } from "./indexing.js";
import type { BazaarReport, CheckResult } from "./types.js";
import { synthesiseVerdict } from "./verdict.js";
import { checkWellKnown } from "./well-known.js";

export type { BazaarReport, BazaarVerdict, CheckResult, CheckStatus } from "./types.js";
export { wellKnownUrlFor, checkWellKnown, type WellKnownFetcher } from "./well-known.js";
export {
  fetchChallenge,
  checkChallenge,
  checkSelfPayment,
  type ChallengeFetcher,
  type ChallengeFetchOptions,
} from "./challenge.js";
export {
  checkIndexing,
  CDP_DISCOVERY_BASE,
  type IndexingCheckOptions,
  type IndexingFetcher,
} from "./indexing.js";
export { synthesiseVerdict } from "./verdict.js";

export interface BazaarCheckOptions {
  readonly serviceUrl: string;
  readonly chain: "base-sepolia" | "base";
  /** Hint: address that would be signing test payments. Optional. */
  readonly payerHint?: string;
  /** Override the CDP discovery base URL (for tests / alternate facilitators). */
  readonly discoveryBaseUrl?: string;
  /** Inject a custom fetch implementation across all HTTP calls. */
  readonly fetcher?: typeof fetch;
  /**
   * X402-42 (D.4) — when set, skip the root `/.well-known/x402` probe
   * entirely and probe `endpoint` directly for the 402 challenge
   * instead. For services that only publish per-route (TensorFeed
   * shape, AsaiShota's test-echo-cdp, 0xdespot's hyperD) or for
   * validating one specific paid route. The default mode (probe root
   * well-known) stays — services that publish at root signal extra
   * discoverability hygiene worth preserving.
   */
  readonly endpoint?: string;
}

/**
 * Run all four bazaar checks and return an aggregated report. Pure
 * orchestration — never throws on individual check failure (each
 * check captures its own error into a CheckResult).
 *
 * When `endpoint` is supplied (X402-42 / D.4), the root
 * `/.well-known/x402` probe is skipped and the challenge is fetched
 * from `endpoint` directly. Self-payment + indexing checks behave
 * identically — they consume the challenge body's payTo regardless
 * of how the challenge was obtained.
 */
export async function runBazaarCheck(opts: BazaarCheckOptions): Promise<BazaarReport> {
  const fetcher = opts.fetcher ?? fetch;
  const results: CheckResult[] = [];

  const useEndpointMode = opts.endpoint !== undefined;
  const challengeUrl = opts.endpoint ?? opts.serviceUrl;

  // 1. Well-known manifest (skipped under --endpoint mode)
  if (useEndpointMode) {
    results.push({
      check: "well-known",
      status: "pass",
      message: `skipped per --endpoint (probing ${opts.endpoint} directly instead of /.well-known/x402)`,
    });
  } else {
    const wk = await checkWellKnown(opts.serviceUrl, fetcher);
    results.push(wk.result);
  }

  // 2. 402 challenge structure (uses endpoint URL when set)
  const challengeFetch = await fetchChallenge(challengeUrl, fetcher);
  results.push(checkChallenge(challengeUrl, challengeFetch, { expectBazaar: true }));

  // 3. Self-payment guard (uses payerHint if supplied; otherwise pass)
  if (challengeFetch.ok) {
    results.push(checkSelfPayment(challengeFetch.requirements.payTo, opts.payerHint));
  } else {
    results.push({
      check: "self-payment",
      status: "pass",
      message: "challenge fetch failed; self-payment guard skipped (no payTo to compare against)",
    });
  }

  // 4. Indexing query (CDP discovery) — only if we have a payTo from the challenge
  if (challengeFetch.ok) {
    results.push(
      await checkIndexing(challengeFetch.requirements.payTo, {
        fetcher,
        ...(opts.discoveryBaseUrl !== undefined ? { discoveryBaseUrl: opts.discoveryBaseUrl } : {}),
      }),
    );
  } else {
    results.push({
      check: "indexing",
      status: "info",
      message: "challenge fetch failed; indexing check skipped (no payTo to query against)",
    });
  }

  return {
    serviceUrl: opts.serviceUrl,
    chain: opts.chain,
    results,
    verdict: synthesiseVerdict(results),
  };
}
