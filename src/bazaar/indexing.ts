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
 *                           `not_found` from this check's perspective
 *   404 / error             treated as `error`
 *
 * The "processing" state is *not* directly returned by CDP discovery —
 * it surfaces as `EXTENSION-RESPONSES: { bazaar: { status: "processing" } }`
 * on `/settle` (moa's report). That's a separate signal handled in
 * `extensionResponsesMissingRule` (X402-33). The discovery endpoint
 * itself just answers indexed-or-not.
 */

import type { CheckResult, IndexingStatus } from "./types.js";

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
}

export async function checkIndexing(
  payTo: string,
  opts: IndexingCheckOptions = {},
): Promise<CheckResult> {
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
      detail: { queryUrl },
    };
  }

  if (response.status === 404) {
    return {
      check: "indexing",
      status: "info",
      message: `discovery returned 404 for payTo=${payTo} — service not indexed yet`,
      fix: `if your settlements have been completing successfully for >24h, this matches the canonical #2207 upstream issue (94 reports). Your code is likely fine; the CDP facilitator side is the gating step.`,
      detail: { queryUrl, httpStatus: 404, status: "not_found" satisfies IndexingStatus },
    };
  }

  if (!response.ok) {
    return {
      check: "indexing",
      status: "info",
      message: `discovery returned HTTP ${response.status} for payTo=${payTo}`,
      fix: `upstream API error. Not your implementation. Retry or check https://status.cloud.coinbase.com.`,
      detail: { queryUrl, httpStatus: response.status, status: "error" satisfies IndexingStatus },
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
      detail: { queryUrl, status: "error" satisfies IndexingStatus },
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
      message: `discovery returned 0 resources for payTo=${payTo}`,
      fix: `if your settlements have been completing successfully for >24h, this matches the canonical #2207 upstream issue (94 reports). Your implementation looks correct from the other checks; the indexing step is upstream.`,
      detail: { queryUrl, status: "not_found" satisfies IndexingStatus, count: 0 },
    };
  }

  return {
    check: "indexing",
    status: "pass",
    message: `discovery returned ${resources.length} resource(s) for payTo=${payTo} — indexed`,
    detail: { queryUrl, status: "indexed" satisfies IndexingStatus, count: resources.length },
  };
}
