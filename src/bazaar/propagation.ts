/**
 * X402-45 (D.2) — metadata propagation diff.
 *
 * Queries the indexer's public-facing record for the service's `payTo`
 * (CDP discovery `/v2/x402/discovery/resources?payTo=<addr>`) and diffs
 * the rendered fields against what the operator declared in the
 * `/.well-known/x402` manifest. Surfaces the @zev pain: manifest is
 * correctly shaped, indexer dropped fields, listing renders blank.
 *
 * What this check reports (via `detail.metadata_propagation`):
 *
 *   - `ok` — every diffed field matches between manifest and indexer.
 *           Status: pass.
 *   - `partial` — at least one but not all diffed fields differ.
 *                 Status: info — upstream signal worth surfacing; your
 *                 implementation is fine.
 *   - `missing` — none of the diffed manifest fields surface in the
 *                indexer. Matches @zev's case (api.lastlookdata.com)
 *                and the canonical #2207 indexer-state-stuck pattern.
 *                Status: info — upstream issue, not yours.
 *   - `unknown` — couldn't determine (no manifest OR no payTo OR
 *                indexer query failed). Status: pass — silent default
 *                so the check doesn't false-positive on inconclusive
 *                runs (e.g. --endpoint mode without a payTo).
 *
 * Fields diffed today: `name` and `description`. Diff scope intentionally
 * narrow — these are the fields TheRoosters / GM / @zev all hit. New
 * fields can be added later when more pain shapes surface.
 *
 * **Facilitator-aware semantics (ADR-004 Pillar 3):** D.2 returns
 * `unknown` for services that don't appear in CDP discovery. The
 * explicit `not_applicable_non_cdp` state (for known-non-CDP services)
 * is layered on top by D.3 (X402-46) via its facilitator-detection
 * pass; D.2 stays narrow and defers the explicit non-CDP attribution
 * to keep the two tickets independently testable.
 */

import { detectFacilitator } from "./facilitator-detect.js";
import type { CheckResult, WellKnownManifest } from "./types.js";

export type MetadataPropagationStatus =
  | "ok"
  | "partial"
  | "missing"
  | "unknown"
  | "not_applicable_non_cdp";

export interface FieldDiff {
  readonly field: string;
  readonly manifest: string | null;
  readonly indexer: string | null;
}

export type PropagationFetcher = (url: string) => Promise<Response>;

export interface PropagationCheckOptions {
  readonly discoveryBaseUrl?: string;
  readonly fetcher?: PropagationFetcher;
}

/** CDP discovery base URL — kept consistent with indexing.ts. */
const CDP_DISCOVERY_BASE_DEFAULT = "https://api.cdp.coinbase.com";

/**
 * Fields the manifest declares that we expect the indexer to surface.
 * Narrow on purpose — TheRoosters / GM / @zev all hit the {name,
 * description} drop. Extend when more pain shapes appear.
 */
const DIFFED_FIELDS = ["name", "description"] as const;

export async function checkPropagation(
  manifest: WellKnownManifest | undefined,
  payTo: string | undefined,
  opts: PropagationCheckOptions = {},
): Promise<CheckResult> {
  // X402-46 (D.3) — short-circuit on declared non-CDP facilitator.
  // Bazaar indexing is CDP-only by design (ADR-004 Pillar 3); the
  // propagation diff is moot for non-CDP services. Return WAI.
  if (detectFacilitator(manifest) === "non-cdp") {
    return {
      check: "propagation",
      status: "pass",
      message: `metadata propagation: not applicable — manifest declares non-CDP facilitator; CDP discovery is not the canonical indexer for this service (ADR-004 Pillar 3)`,
      detail: {
        metadata_propagation: "not_applicable_non_cdp" satisfies MetadataPropagationStatus,
      },
    };
  }

  if (manifest === undefined || payTo === undefined) {
    return {
      check: "propagation",
      status: "pass",
      message: `metadata propagation: unknown — ${manifest === undefined ? "no manifest available (--endpoint mode skips well-known)" : "no payTo extractable from challenge"}`,
      detail: { metadata_propagation: "unknown" satisfies MetadataPropagationStatus },
    };
  }

  const baseUrl = opts.discoveryBaseUrl ?? CDP_DISCOVERY_BASE_DEFAULT;
  const fetcher = opts.fetcher ?? fetch;
  const queryUrl = `${baseUrl.replace(/\/$/, "")}/v2/x402/discovery/resources?payTo=${encodeURIComponent(payTo)}`;

  let response: Response;
  try {
    response = await fetcher(queryUrl);
  } catch (err) {
    return {
      check: "propagation",
      status: "pass",
      message: `metadata propagation: unknown — discovery query failed: ${err instanceof Error ? err.message : String(err)}`,
      detail: {
        metadata_propagation: "unknown" satisfies MetadataPropagationStatus,
        queryUrl,
      },
    };
  }

  if (!response.ok) {
    return {
      check: "propagation",
      status: "pass",
      message: `metadata propagation: unknown — discovery returned HTTP ${response.status} for payTo=${payTo}`,
      detail: {
        metadata_propagation: "unknown" satisfies MetadataPropagationStatus,
        queryUrl,
        httpStatus: response.status,
      },
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      check: "propagation",
      status: "pass",
      message: `metadata propagation: unknown — discovery returned non-JSON body for payTo=${payTo}`,
      detail: {
        metadata_propagation: "unknown" satisfies MetadataPropagationStatus,
        queryUrl,
      },
    };
  }

  const resources =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)["resources"]
      : undefined;
  if (!Array.isArray(resources) || resources.length === 0) {
    return {
      check: "propagation",
      status: "pass",
      message: `metadata propagation: unknown — discovery returned 0 resources for payTo=${payTo} (service not indexed yet; cannot diff)`,
      detail: {
        metadata_propagation: "unknown" satisfies MetadataPropagationStatus,
        queryUrl,
      },
    };
  }

  // Use the first resource. Multi-route operators may surface multiple
  // resources per payTo; v1 narrows to the first as the canonical
  // entry. Multi-resource diff is a future refinement when a real
  // operator surfaces that pain.
  const resource = resources[0];
  const indexer = isRecord(resource) ? resource : {};

  const diff: FieldDiff[] = [];
  for (const field of DIFFED_FIELDS) {
    const manifestValue = stringFieldOrNull(manifest as unknown as Record<string, unknown>, field);
    const indexerValue = stringFieldOrNull(indexer, field);
    if (manifestValue !== indexerValue) {
      diff.push({ field, manifest: manifestValue, indexer: indexerValue });
    }
  }

  const status = computePropagationStatus(diff, DIFFED_FIELDS.length);

  if (status === "ok") {
    return {
      check: "propagation",
      status: "pass",
      message: `metadata propagation: ok — all diffed fields (${DIFFED_FIELDS.join(", ")}) match between manifest and CDP discovery for payTo=${payTo}`,
      detail: {
        metadata_propagation: "ok" satisfies MetadataPropagationStatus,
        queryUrl,
      },
    };
  }

  // `partial` and `missing` are both info-status (upstream signals).
  const messagePrefix =
    status === "missing"
      ? "metadata propagation: missing — your manifest declares values but the indexer surfaces none of them. Matches the @zev / TheRoosters / GM pattern (and the canonical #2207 indexer-state cluster)."
      : `metadata propagation: partial — ${diff.length}/${DIFFED_FIELDS.length} diffed fields drifted between your manifest and the indexer rendering.`;

  return {
    check: "propagation",
    status: "info",
    message: messagePrefix,
    fix:
      status === "missing"
        ? `your implementation is fine; this is an upstream Bazaar indexer state. If settles have completed successfully for >24h and the listing is still blank, this matches #2207. Wait or escalate to CDP.`
        : `verify the field values in your manifest are exactly what you want; if they're correct, the drift is upstream. The diff lists each affected field.`,
    detail: {
      metadata_propagation: status,
      queryUrl,
      diff,
    },
  };
}

/**
 * Decide ok / partial / missing based on the diff count.
 * Pure function — exported so verdict shape stays deterministic in
 * tests.
 */
export function computePropagationStatus(
  diff: readonly FieldDiff[],
  diffedFieldCount: number,
): MetadataPropagationStatus {
  if (diff.length === 0) return "ok";
  // "missing" = every diffed manifest value is non-null AND every
  // indexer value is null. That's the @zev shape — manifest correct,
  // indexer shows nothing.
  const allManifestPresent = diff.every((d) => d.manifest !== null);
  const allIndexerAbsent = diff.every((d) => d.indexer === null);
  if (diff.length === diffedFieldCount && allManifestPresent && allIndexerAbsent) {
    return "missing";
  }
  return "partial";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringFieldOrNull(obj: Record<string, unknown>, field: string): string | null {
  const v = obj[field];
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}
