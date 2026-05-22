/**
 * X402-46 (D.3) — shared facilitator detection helper.
 *
 * ADR-004 Pillar 3 establishes that Bazaar indexing is CDP-only by
 * design (Cryptor + Ferj correction 2026-05-21). Non-CDP services
 * (self-hosted facilitators, x402-rs, alternative providers) do NOT
 * appear in CDP discovery — that's working-as-intended, not a bug.
 *
 * Both D.2 (propagation diff) and D.3 (indexer-state probe) need to
 * answer: "is this service CDP-settled?" — so the verdict can return
 * `not_applicable_non_cdp` (rolling up to `looks_correct`) instead of
 * false-positive `upstream_issue` on a working non-CDP service.
 *
 * **v1 detection mechanism: manifest-claim only.** If the operator
 * declares `extensions.bazaar.facilitator` in their well-known
 * manifest, trust it. Three other options exist per ADR-004 Pillar 3
 * (TomSmart's `facilitator_inferred` field, empirical probe, hybrid)
 * but they require either external fixture data (still pending Sun
 * 2026-05-24 drop) or additional HTTP calls. Manifest-claim is fast,
 * synchronous, and correct for the operators who self-declare.
 *
 * **Default behavior is `unknown`** (not `cdp`) when the manifest
 * doesn't declare. This is intentional: the upstream check path
 * already handles "indexed in CDP discovery" vs "not indexed" — the
 * facilitator-detect helper is for the case where the operator has
 * explicitly told us they're non-CDP, and we should respect that
 * declaration even before/without hitting the network.
 */

import type { WellKnownManifest } from "./types.js";

export type FacilitatorDetectionResult = "cdp" | "non-cdp" | "unknown";

/**
 * Detect the facilitator a service settles through, based on its
 * well-known manifest declaration.
 *
 * Recognised CDP claim values (case-insensitive): `"coinbase-cdp"`,
 * `"cdp"`, `"coinbase"`. Any other non-empty string value of
 * `extensions.bazaar.facilitator` is treated as non-CDP.
 *
 * Returns `unknown` when:
 *   - `manifest` is undefined (e.g., --endpoint mode skipped well-known)
 *   - `extensions.bazaar` is missing or not an object
 *   - `extensions.bazaar.facilitator` is missing, not a string, or
 *     whitespace-only
 *
 * The undefined-manifest case (`--endpoint` mode) returning `unknown`
 * preserves the conservative path: if we don't have the manifest, we
 * don't make an attribution. D.2 and D.3 already handle the unknown
 * case correctly by returning their own `unknown` state.
 */
export function detectFacilitator(
  manifest: WellKnownManifest | undefined,
): FacilitatorDetectionResult {
  if (manifest === undefined) return "unknown";
  const extensions = manifest.extensions;
  if (typeof extensions !== "object" || extensions === null) return "unknown";
  const bazaar = (extensions as Record<string, unknown>)["bazaar"];
  if (typeof bazaar !== "object" || bazaar === null) return "unknown";
  const claim = (bazaar as Record<string, unknown>)["facilitator"];
  if (typeof claim !== "string") return "unknown";
  const normalised = claim.trim().toLowerCase();
  if (normalised === "") return "unknown";
  if (normalised === "coinbase-cdp" || normalised === "cdp" || normalised === "coinbase") {
    return "cdp";
  }
  return "non-cdp";
}
