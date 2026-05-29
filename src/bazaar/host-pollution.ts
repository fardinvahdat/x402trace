/**
 * X402-53 (v0.3.4 L) — host_pollution listing-hygiene check.
 *
 * Queries CDP's merchant discovery endpoint
 * (`/platform/v2/x402/discovery/merchant?payTo=<addr>&limit=N`) and
 * groups returned resources by canonical path. When a path appears
 * indexed under more than one hostname for the same payTo, fires
 * a WARNING (status: info) — code is correct, ops are leaky.
 *
 * Concretely: an operator running AWS Lambda + custom-domain (or
 * CDN-fronted endpoints) will silently surface the same Lambda
 * handler under multiple hostnames. CDP discovery captures the URL
 * the buyer hit (not a canonical resource URL), so the merchant
 * index shows N entries per real endpoint when the same path is
 * reachable through M hostnames. Ferj's anchor-x402 setup is the
 * canonical case: `/v1/anchor` indexed under both
 * `api.anchor-x402.com` and the raw API Gateway URL
 * (`1c09pdnrx1.execute-api.us-east-1.amazonaws.com`), 23+ entries
 * for one payTo across three hosts (per #x402 Discord 2026-05-27).
 *
 * ADR-008 (single-voice bypass under D.5 precedent) records the
 * promotion rationale. Memory: [[candidate-L-host-pollution-v034-bypass]].
 *
 * Cross-facet precedence (per ADR-006 § Consequences risk #5):
 * `host_pollution` is a WARNING that sits alongside the technical
 * verdict — `looks_correct` continues to roll up exit code 0 even
 * when the facet fires. The verdict synthesizer treats
 * `host-pollution` info-status separately from the upstream-checks
 * set (indexing, propagation), so it never flips the exit code.
 *
 * Endpoint distinction:
 *
 *   - `/v2/x402/discovery/resources?payTo=...` — buyer-facing
 *     discovery (used by `checkIndexing` in `indexing.ts`).
 *   - `/platform/v2/x402/discovery/merchant?payTo=...` — merchant
 *     surface returning the canonical index entries (used here).
 *
 * The two paths return arrays with similar shape but differ in
 * which fields are normalized; for host-pollution we only need the
 * `resource` URL field to extract host + path.
 */

import { detectFacilitator } from "./facilitator-detect.js";
import type { CheckResult, HostPollutionFacet, PollutedPath, WellKnownManifest } from "./types.js";

export type HostPollutionFetcher = (url: string) => Promise<Response>;

/** Default CDP base for merchant discovery; override via `discoveryBaseUrl` for tests. */
export const CDP_MERCHANT_DISCOVERY_BASE = "https://api.cdp.coinbase.com";

/** Default page-size hint sent to CDP. The endpoint paginates; 50 is a reasonable max for v0.3.4. */
export const DEFAULT_MERCHANT_DISCOVERY_LIMIT = 50;

export interface HostPollutionCheckOptions {
  readonly discoveryBaseUrl?: string;
  readonly fetcher?: HostPollutionFetcher;
  /**
   * Manifest for facilitator detection. When the operator declares a
   * non-CDP facilitator in `extensions.bazaar.facilitator`, the
   * merchant discovery query is skipped (CDP-only by design — same
   * pattern as `indexing.ts`'s `not_applicable_non_cdp` short-circuit).
   */
  readonly manifest?: WellKnownManifest;
  /** Optional page-size override. Defaults to {@link DEFAULT_MERCHANT_DISCOVERY_LIMIT}. */
  readonly limit?: number;
}

interface ParsedResourceUrl {
  readonly host: string;
  readonly path: string;
}

/**
 * Extract a canonical (host, path) tuple from a resource URL string.
 * Returns `null` if the URL is malformed.
 *
 * Hostname is lowercased + IDN ACE-normalised by the URL parser so
 * non-ASCII hostnames group correctly. Path is the URL `pathname`
 * (no query string, no fragment) so two entries differing only in
 * query parameters collapse to the same canonical path.
 */
export function parseResourceUrl(resourceUrl: string): ParsedResourceUrl | null {
  try {
    const u = new URL(resourceUrl);
    return { host: u.host.toLowerCase(), path: u.pathname };
  } catch {
    return null;
  }
}

/**
 * Pure grouping function: takes an array of resource URL strings,
 * returns the list of paths that appear on more than one host
 * (sorted ascending by path) and aggregate counts.
 *
 * Exported for direct unit testing of the grouping logic without
 * needing a mock fetcher.
 */
export function findHostPollution(resourceUrls: readonly string[]): {
  pollutedPaths: PollutedPath[];
  totalEntries: number;
  distinctHosts: number;
} {
  const pathHostMap = new Map<string, Set<string>>();
  const allHosts = new Set<string>();
  let validEntries = 0;

  for (const url of resourceUrls) {
    const parsed = parseResourceUrl(url);
    if (!parsed) continue;
    validEntries += 1;
    allHosts.add(parsed.host);
    let hosts = pathHostMap.get(parsed.path);
    if (!hosts) {
      hosts = new Set<string>();
      pathHostMap.set(parsed.path, hosts);
    }
    hosts.add(parsed.host);
  }

  const pollutedPaths: PollutedPath[] = [];
  for (const [path, hosts] of pathHostMap) {
    if (hosts.size > 1) {
      pollutedPaths.push({
        resource_path: path,
        hosts: [...hosts].sort(),
      });
    }
  }
  pollutedPaths.sort((a, b) => a.resource_path.localeCompare(b.resource_path));

  return {
    pollutedPaths,
    totalEntries: validEntries,
    distinctHosts: allHosts.size,
  };
}

function unknownResult(message: string, detail: Record<string, unknown>): CheckResult {
  const facet: HostPollutionFacet = { state: "unknown" };
  return {
    check: "host-pollution",
    status: "pass",
    message,
    detail: { ...detail, ...facet },
  };
}

export async function checkHostPollution(
  payTo: string,
  opts: HostPollutionCheckOptions = {},
): Promise<CheckResult> {
  if (detectFacilitator(opts.manifest) === "non-cdp") {
    const facet: HostPollutionFacet = { state: "not_applicable_non_cdp" };
    return {
      check: "host-pollution",
      status: "pass",
      message:
        "manifest declares non-CDP facilitator; CDP merchant discovery not consulted (host-pollution check is CDP-only by design)",
      detail: { ...facet },
    };
  }

  const baseUrl = opts.discoveryBaseUrl ?? CDP_MERCHANT_DISCOVERY_BASE;
  const fetcher = opts.fetcher ?? fetch;
  const limit = opts.limit ?? DEFAULT_MERCHANT_DISCOVERY_LIMIT;
  const queryUrl = `${baseUrl.replace(/\/$/, "")}/platform/v2/x402/discovery/merchant?payTo=${encodeURIComponent(payTo)}&limit=${limit}`;

  let response: Response;
  try {
    response = await fetcher(queryUrl);
  } catch (err) {
    return unknownResult(
      `merchant discovery query failed: ${err instanceof Error ? err.message : String(err)}`,
      { queryUrl },
    );
  }

  if (!response.ok) {
    return unknownResult(
      `merchant discovery returned HTTP ${response.status}; host-pollution check skipped`,
      { queryUrl, httpStatus: response.status },
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return unknownResult(
      "merchant discovery returned non-JSON body; host-pollution check skipped",
      {
        queryUrl,
      },
    );
  }

  const resources =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)["resources"]
      : undefined;

  if (!Array.isArray(resources) || resources.length === 0) {
    const facet: HostPollutionFacet = {
      state: "no_pollution",
      total_entries: 0,
      distinct_hosts: 0,
    };
    return {
      check: "host-pollution",
      status: "pass",
      message: `merchant discovery returned 0 entries for payTo=${payTo}; nothing to flag`,
      detail: { queryUrl, ...facet },
    };
  }

  const resourceUrls: string[] = [];
  for (const r of resources) {
    if (typeof r !== "object" || r === null) continue;
    const resourceUrl = (r as Record<string, unknown>)["resource"];
    if (typeof resourceUrl === "string") resourceUrls.push(resourceUrl);
  }

  const { pollutedPaths, totalEntries, distinctHosts } = findHostPollution(resourceUrls);

  if (pollutedPaths.length === 0) {
    const facet: HostPollutionFacet = {
      state: "no_pollution",
      total_entries: totalEntries,
      distinct_hosts: distinctHosts,
    };
    return {
      check: "host-pollution",
      status: "pass",
      message: `merchant discovery has ${totalEntries} entries across ${distinctHosts} host(s); no path indexed on more than one host`,
      detail: { queryUrl, ...facet },
    };
  }

  const facet: HostPollutionFacet = {
    state: "polluted",
    polluted_paths: pollutedPaths,
    polluted_path_count: pollutedPaths.length,
    total_entries: totalEntries,
    distinct_hosts: distinctHosts,
  };
  return {
    check: "host-pollution",
    status: "info",
    message: `${pollutedPaths.length} resource path(s) indexed under ${distinctHosts} distinct hosts in CDP merchant discovery for payTo=${payTo}`,
    fix: `your code is correct, but multiple hostnames front the same Lambda/handler. CDP captures the URL the buyer hit (not the canonical resource URL), so the merchant index shows duplicate entries per path. Consider configuring CDN/Lambda to canonicalize to one host. This is a listing-hygiene warning, not an implementation failure — exit code unchanged.`,
    detail: { queryUrl, ...facet },
  };
}
