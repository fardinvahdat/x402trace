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
}

/**
 * Run all four bazaar checks and return an aggregated report. Pure
 * orchestration — never throws on individual check failure (each
 * check captures its own error into a CheckResult).
 */
export async function runBazaarCheck(opts: BazaarCheckOptions): Promise<BazaarReport> {
  const fetcher = opts.fetcher ?? fetch;
  const results: CheckResult[] = [];

  // 1. Well-known manifest
  const wk = await checkWellKnown(opts.serviceUrl, fetcher);
  results.push(wk.result);

  // 2. 402 challenge structure
  const challengeFetch = await fetchChallenge(opts.serviceUrl, fetcher);
  results.push(checkChallenge(opts.serviceUrl, challengeFetch, { expectBazaar: true }));

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
