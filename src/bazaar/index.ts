/**
 * X402-32 — bazaar-check orchestration.
 *
 * Composes the five checks (well-known, challenge, self-payment,
 * indexing, propagation) into a single report. Each check runs
 * independently with its own fetcher injection so unit tests stay
 * hermetic and the integration test can wire a single fetcher across
 * all of them.
 *
 * **v0.3 scope cut:** the paid-pass mode (`--with-wallet`) mentioned in
 * the Jira AC is deferred to v0.3.1. The bazaar-check shipped here is
 * static-analysis only — it does NOT submit a signed payment. The
 * EXTENSION-RESPONSES missing detection (via X402-33's
 * `extensionResponsesMissingRule`) fires only when a future caller
 * actually drives the settle path and surfaces the response headers.
 * See the X402-32 audit log for the rationale.
 *
 * **v0.3.2 addition (X402-45 / D.2):** the propagation check diffs
 * `/.well-known/x402` manifest against CDP discovery's rendered
 * resource fields, surfacing the @zev pain (manifest correct, indexer
 * dropped fields, listing renders blank).
 */

import { checkChallenge, fetchChallenge, checkSelfPayment } from "./challenge.js";
import { checkFacilitatorFitness } from "./facilitator-fitness.js";
import { checkHostPollution } from "./host-pollution.js";
import { checkIndexing } from "./indexing.js";
import { checkPropagation } from "./propagation.js";
import type {
  BazaarReport,
  CheckResult,
  PaymentPayloadCapture,
  SettleResponseCapture,
  WellKnownManifest,
} from "./types.js";
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
export {
  checkPropagation,
  type MetadataPropagationStatus,
  type FieldDiff,
  type PropagationCheckOptions,
  type PropagationFetcher,
} from "./propagation.js";
export {
  checkHostPollution,
  findHostPollution,
  parseResourceUrl,
  CDP_MERCHANT_DISCOVERY_BASE,
  DEFAULT_MERCHANT_DISCOVERY_LIMIT,
  type HostPollutionCheckOptions,
  type HostPollutionFetcher,
} from "./host-pollution.js";
export {
  evaluatePaymentPayloadEchoGap,
  evaluateMissingResourceObject,
  evaluateExtensionsNotEchoed,
  type PaymentPayloadEchoGapResult,
} from "./payment-payload-rules.js";
export {
  checkFacilitatorFitness,
  loadFacilitatorRegistry,
  resolveFacilitator,
  probeFacilitatorWithRetry,
  DEFAULT_PROBE_TIMEOUT_MS,
  PROBE_RETRY_DELAYS_MS,
  type FacilitatorFitnessFetcher,
  type FacilitatorFitnessOptions,
} from "./facilitator-fitness.js";
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
  /**
   * X402-50 (K, ADR-007) — optional buyer-side payment payload
   * capture for Rule 1 (`payment_payload_missing_resource_object`).
   * When supplied, the verdict synthesizer can attribute an
   * `upstream_stuck` verdict to a `payload_echo_gap` cause vs an
   * indexer-state-derived cause. Without it, Rule 1 defers (never
   * false-positives).
   *
   * Supplied by proxy mode (when integrated) or fixture-replay via
   * `tests/fixtures/bazaar/captured-responses/*.json`'s optional
   * `mocks.paymentPayload` block.
   */
  readonly paymentPayloadCapture?: PaymentPayloadCapture;
  /**
   * X402-50 (K, ADR-007) — optional /settle response capture for
   * Rule 2 (`extensions_not_echoed`). When supplied, the rule checks
   * for the canonical `EXTENSION-RESPONSES: e30=` signature against
   * the challenge-side `extensions` declaration. Without it, Rule 2
   * defers.
   */
  readonly settleCapture?: SettleResponseCapture;
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
  let manifest: WellKnownManifest | undefined;
  if (useEndpointMode) {
    results.push({
      check: "well-known",
      status: "pass",
      message: `skipped per --endpoint (probing ${opts.endpoint} directly instead of /.well-known/x402)`,
    });
  } else {
    const wk = await checkWellKnown(opts.serviceUrl, fetcher);
    results.push(wk.result);
    manifest = wk.manifest;
  }

  // 2. 402 challenge structure (uses endpoint URL when set)
  const challengeFetch = await fetchChallenge(challengeUrl, fetcher);
  const challengeResult = checkChallenge(challengeUrl, challengeFetch, { expectBazaar: true });
  // X402-50 (K) — surface the parsed challenge `extensions` block on
  // the challenge check's detail so the verdict synthesizer can read
  // it for Rule 2 (`extensions_not_echoed`) without re-parsing the
  // raw 402 body. Additive per X402-44; existing consumers ignore.
  if (challengeFetch.ok && challengeResult.status === "pass") {
    const rawBody = challengeFetch.rawBody;
    if (typeof rawBody === "object" && rawBody !== null) {
      const challengeExtensions = (rawBody as Record<string, unknown>)["extensions"];
      if (challengeExtensions !== undefined) {
        results.push({
          ...challengeResult,
          detail: { ...(challengeResult.detail ?? {}), challengeExtensions },
        });
      } else {
        results.push(challengeResult);
      }
    } else {
      results.push(challengeResult);
    }
  } else {
    results.push(challengeResult);
  }

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

  // 4. Indexing query (CDP discovery) — only if we have a payTo from the challenge.
  //    X402-46 (D.3): manifest is passed for facilitator detection (short-circuits to
  //    `not_applicable_non_cdp` when the operator declares a non-CDP facilitator).
  if (challengeFetch.ok) {
    results.push(
      await checkIndexing(challengeFetch.requirements.payTo, {
        fetcher,
        ...(opts.discoveryBaseUrl !== undefined ? { discoveryBaseUrl: opts.discoveryBaseUrl } : {}),
        ...(manifest !== undefined ? { manifest } : {}),
      }),
    );
  } else {
    results.push({
      check: "indexing",
      status: "info",
      message: "challenge fetch failed; indexing check skipped (no payTo to query against)",
    });
  }

  // 5. Propagation diff (X402-45 / D.2) — diff manifest fields vs
  // CDP discovery rendered fields. Surfaces @zev / TheRoosters / GM
  // pain: manifest correct, indexer dropped fields, listing blank.
  const payToForPropagation = challengeFetch.ok ? challengeFetch.requirements.payTo : undefined;
  results.push(
    await checkPropagation(manifest, payToForPropagation, {
      fetcher,
      ...(opts.discoveryBaseUrl !== undefined ? { discoveryBaseUrl: opts.discoveryBaseUrl } : {}),
    }),
  );

  // 6. Host pollution (X402-53 / L) — CDP merchant discovery returns
  //    N entries spread across M distinct hostnames for the same
  //    payTo when multi-host CDN/Lambda setups front the same handler.
  //    Listing-hygiene warning: code is correct, ops are leaky.
  //    Status `info` here is informational only — the verdict
  //    synthesizer does NOT include `host-pollution` in its
  //    upstream-checks set, so this never flips the exit code.
  //    Per ADR-008. Same non-CDP short-circuit pattern as indexing.
  if (challengeFetch.ok) {
    results.push(
      await checkHostPollution(challengeFetch.requirements.payTo, {
        fetcher,
        ...(opts.discoveryBaseUrl !== undefined ? { discoveryBaseUrl: opts.discoveryBaseUrl } : {}),
        ...(manifest !== undefined ? { manifest } : {}),
      }),
    );
  } else {
    results.push({
      check: "host-pollution",
      status: "pass",
      message: "challenge fetch failed; host-pollution check skipped (no payTo to query against)",
    });
  }

  // 7. Facilitator fitness (X402-51 / G) — probe declared facilitator
  //    per-rail; emit array of per-rail fitness states (ok/degraded/
  //    unreachable/unknown). Per ADR-005, identity source is the
  //    manifest's declared extensions.bazaar.facilitator field (NOT
  //    tx-from inference, load-bearing for gasless rails).
  //    Status `info` if any rail is unreachable (rolls up to
  //    upstream_issue verdict, exit 3); `pass` otherwise — degraded
  //    rails surface in facet but don't flip verdict.
  results.push(
    await checkFacilitatorFitness(manifest, {
      fetcher,
    }),
  );

  return {
    serviceUrl: opts.serviceUrl,
    chain: opts.chain,
    results,
    verdict: synthesiseVerdict(results, {
      ...(opts.paymentPayloadCapture !== undefined
        ? { paymentPayloadCapture: opts.paymentPayloadCapture }
        : {}),
      ...(opts.settleCapture !== undefined ? { settleCapture: opts.settleCapture } : {}),
    }),
  };
}
