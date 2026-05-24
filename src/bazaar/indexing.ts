/**
 * X402-32 — Bazaar indexing query.
 *
 * Hits the CDP discovery endpoint
 * (`/v2/x402/discovery/resources?payTo=<addr>`) and reports the
 * indexing status for that payTo. This is the check that distinguishes
 * "my implementation is broken" from "I'm hitting the canonical
 * upstream #2207 bug" — the latter shows as `processing` stuck
 * indefinitely or `not_found` despite documented successful settles.
 *
 * Response shape (per CDP docs + Discord transcript observations):
 *
 *   { resources: [...] }    if the payTo is indexed (at least one
 *                           resource visible)
 *   { resources: [] }       payTo seen but no resources indexed →
 *                           `processing` from this check's perspective
 *                           (#2207 cluster — Max's polyodds.bet case)
 *   404 / error             treated as `unknown`
 *
 * **v0.3.2 addition (X402-46 / D.3):** every result emits a
 * `detail.indexer_state` facet per the new IndexerState enum. When the
 * caller passes the manifest, the facilitator-detect helper layers
 * `not_applicable_non_cdp` on top — non-CDP services produce a pass
 * verdict (WAI per ADR-004 Pillar 3), not a false-positive upstream
 * signal.
 *
 * The "processing" state surfaces here as 404/empty from CDP discovery.
 * The EXTENSION-RESPONSES `bazaar.status: "processing"` signal from
 * `/settle` (moa's report) is a separate cross-validation handled in
 * `extensionResponsesMissingRule` (X402-33).
 */

import { detectFacilitator } from "./facilitator-detect.js";
import type { CheckResult, IndexerState, IndexingStatus, WellKnownManifest } from "./types.js";

export type IndexingFetcher = (url: string) => Promise<Response>;

/**
 * CDP's discovery base URL. Hardcoded but recoverable: callers can
 * override via the `discoveryBaseUrl` option for testing or for
 * pointing at a different facilitator's discovery surface.
 */
export const CDP_DISCOVERY_BASE = "https://api.cdp.coinbase.com";

export interface IndexingCheckOptions {
  readonly discoveryBaseUrl?: string;
  readonly fetcher?: IndexingFetcher;
  /**
   * X402-46 (D.3) — manifest for facilitator detection. When the
   * operator declares a non-CDP facilitator in `extensions.bazaar.
   * facilitator`, indexing returns `not_applicable_non_cdp` (pass)
   * rather than false-positive `processing` (info → upstream signal).
   */
  readonly manifest?: WellKnownManifest;
}

export async function checkIndexing(
  payTo: string,
  opts: IndexingCheckOptions = {},
): Promise<CheckResult> {
  // X402-46 (D.3) — short-circuit on declared non-CDP facilitator.
  // Bazaar indexing is CDP-only by design; non-CDP absence is WAI.
  if (detectFacilitator(opts.manifest) === "non-cdp") {
    return {
      check: "indexing",
      status: "pass",
      message: `manifest declares non-CDP facilitator; CDP discovery is not the canonical indexer for this service (ADR-004 Pillar 3)`,
      detail: { indexer_state: "not_applicable_non_cdp" satisfies IndexerState },
    };
  }

  const baseUrl = opts.discoveryBaseUrl ?? CDP_DISCOVERY_BASE;
  const fetcher = opts.fetcher ?? fetch;
  const queryUrl = `${baseUrl.replace(/\/$/, "")}/v2/x402/discovery/resources?payTo=${encodeURIComponent(payTo)}`;

  let response: Response;
  try {
    response = await fetcher(queryUrl);
  } catch (err) {
    return {
      check: "indexing",
      status: "info",
      message: `discovery query failed: ${err instanceof Error ? err.message : String(err)}`,
      fix: `network reachability issue, not your implementation. Try again later or check the discovery base URL: ${baseUrl}.`,
      detail: { queryUrl, indexer_state: "unknown" satisfies IndexerState },
    };
  }

  if (response.status === 404) {
    return {
      check: "indexing",
      status: "info",
      message: `discovery returned 404 for payTo=${payTo} — service not indexed yet (processing)`,
      fix: `if your settlements have been completing successfully for >24h, this matches the canonical #2207 upstream issue (94 reports). Your code is likely fine; the CDP facilitator side is the gating step.`,
      detail: {
        queryUrl,
        httpStatus: 404,
        status: "processing" satisfies IndexingStatus,
        indexer_state: "processing" satisfies IndexerState,
      },
    };
  }

  if (!response.ok) {
    return {
      check: "indexing",
      status: "info",
      message: `discovery returned HTTP ${response.status} for payTo=${payTo}`,
      fix: `upstream API error. Not your implementation. Retry or check https://status.cloud.coinbase.com.`,
      detail: {
        queryUrl,
        httpStatus: response.status,
        status: "error" satisfies IndexingStatus,
        indexer_state: "unknown" satisfies IndexerState,
      },
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      check: "indexing",
      status: "info",
      message: `discovery returned non-JSON body for payTo=${payTo}`,
      fix: `upstream API shape change — please file an issue at fardinvahdat/x402trace if this persists.`,
      detail: {
        queryUrl,
        status: "error" satisfies IndexingStatus,
        indexer_state: "unknown" satisfies IndexerState,
      },
    };
  }

  const resources =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)["resources"]
      : undefined;

  if (!Array.isArray(resources) || resources.length === 0) {
    return {
      check: "indexing",
      status: "info",
      message: `discovery returned 0 resources for payTo=${payTo} — service not indexed yet (processing)`,
      fix: `if your settlements have been completing successfully for >24h, this matches the canonical #2207 upstream issue (94 reports). Your implementation looks correct from the other checks; the indexing step is upstream.`,
      detail: {
        queryUrl,
        status: "processing" satisfies IndexingStatus,
        count: 0,
        indexer_state: "processing" satisfies IndexerState,
      },
    };
  }

  return {
    check: "indexing",
    status: "pass",
    message: `discovery returned ${resources.length} resource(s) for payTo=${payTo} — indexed`,
    detail: {
      queryUrl,
      status: "indexed" satisfies IndexingStatus,
      count: resources.length,
      indexer_state: "indexed" satisfies IndexerState,
    },
  };
}
