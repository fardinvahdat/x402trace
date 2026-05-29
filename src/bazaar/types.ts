/**
 * X402-32 — bazaar-check shared types.
 *
 * `bazaar-check <service-url>` runs four independent checks and
 * synthesises a single verdict that answers the operator's question:
 * *"is my Bazaar / agentic.market integration implemented correctly,
 * or is the bug upstream of me?"*
 *
 * Each check returns a `CheckResult` with one of three statuses:
 *
 *   - `pass`   — the check found no issue in your implementation
 *   - `fail`   — the check found a concrete issue in your implementation
 *   - `info`   — the check observed an upstream-bound signal that is NOT
 *                your fault but IS worth surfacing (e.g. CDP indexing
 *                stuck on "processing" — matches #2207)
 *
 * The verdict synthesiser maps the per-check matrix onto an
 * exit-code + bottom-line message per the Jira AC:
 *
 *   - 0 — looks correct, no issues observed
 *   - 2 — found issues in your implementation (any `fail`)
 *   - 3 — implementation looks correct but upstream `info` signal
 *         worth surfacing (e.g. EXTENSION-RESPONSES missing in #2207)
 *
 * Read-only by construction: never signs, never broadcasts. The opt-in
 * paid-pass mode mentioned in the Jira ticket is **deferred to v0.3.1**
 * — see the X402-32 audit log for the scope cut.
 */

import type { PaymentRequirements } from "../decoder/types.js";

export type CheckStatus = "pass" | "fail" | "info";

export interface CheckResult {
  /** Stable identifier; downstream tools grep / filter on this. */
  readonly check: string;
  readonly status: CheckStatus;
  /** One-line human-readable description. */
  readonly message: string;
  /** Actionable fix; only present when `status === "fail"` or `"info"`. */
  readonly fix?: string;
  /** Optional structured detail for JSON output. */
  readonly detail?: Record<string, unknown>;
}

/**
 * Aggregated bazaar-check report. Both human and JSON output formats
 * are derived from this shape.
 */
export interface BazaarReport {
  readonly serviceUrl: string;
  readonly chain: "base-sepolia" | "base";
  readonly results: readonly CheckResult[];
  /** Top-level verdict + exit code derivation. */
  readonly verdict: BazaarVerdict;
}

export type BazaarVerdict =
  | {
      readonly kind: "looks_correct";
      readonly message: string;
      /** Exit 0. */
      readonly exitCode: 0;
    }
  | {
      readonly kind: "implementation_issue";
      readonly message: string;
      /** Exit 2. */
      readonly exitCode: 2;
      readonly failedChecks: readonly string[];
    }
  | {
      readonly kind: "upstream_issue";
      readonly message: string;
      /** Exit 3. */
      readonly exitCode: 3;
      readonly upstreamChecks: readonly string[];
    }
  | {
      /**
       * X402-46 (D.3) — facilitator settled, but downstream indexer
       * hasn't advanced past `processing`. Distinct from generic
       * `upstream_issue` because the root cause is known: the indexer
       * queue is stuck. Per ADR-004 Pillar 1, rolls up to exit code 3
       * (preserves CI contract); verdict prose + JSON facets carry
       * the granularity.
       *
       * X402-50 (K, ADR-007) — adds the `cause` discriminator
       * sub-classifying WHY the indexer is stuck (payload echo gap,
       * indexer-state-processing, indexer-state-terminal, or unknown).
       * Strictly additive — `kind` and `exitCode` unchanged.
       */
      readonly kind: "upstream_stuck";
      readonly message: string;
      /** Exit 3 (same as `upstream_issue`). */
      readonly exitCode: 3;
      readonly upstreamChecks: readonly string[];
      /** X402-50 (K) — see UpstreamStuckCause. */
      readonly cause: UpstreamStuckCause;
    };

/**
 * Subset of `/.well-known/x402` manifest fields bazaar-check validates.
 * Operators care about these because Bazaar listing pulls from them.
 * Extra fields are tolerated (we don't enforce a closed schema).
 */
export interface WellKnownManifest {
  readonly name?: string;
  readonly description?: string;
  readonly accepts?: readonly unknown[];
  readonly extensions?: Record<string, unknown>;
  /**
   * Operator-declared discovery extension opt-in. When set to `"bazaar"`,
   * `extensions.bazaar.{name, description}` are mandatory and validated
   * here. Declared empty / absent means bazaar listing is not opted in
   * and the extension fields are not required (manifest still validated
   * for top-level name/description).
   */
  readonly discovery_extension?: string;
}

/**
 * Captured 402 challenge result. Either we got a well-formed challenge,
 * or we got something else (non-402 status, non-JSON body, missing
 * accepts[] entry, etc.) that the `challenge` check will fail on.
 */
export type ChallengeFetchResult =
  | {
      readonly ok: true;
      readonly requirements: PaymentRequirements;
      readonly rawBody: unknown;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly httpStatus?: number;
    };

/**
 * CDP discovery query result for a given payTo address. We tolerate
 * spec drift in the response shape by returning a coarse status.
 */
export type IndexingStatus = "indexed" | "processing" | "not_found" | "error";

/**
 * X402-46 (D.3) — verdict facet on the indexing check carrying the
 * canonical indexer-state classification. Surfaced as
 * `detail.indexer_state` on the indexing check's CheckResult.
 *
 *   - `indexed` — CDP discovery returns ≥1 resource for the payTo
 *   - `processing` — discovery returned 404 or empty resources;
 *     downstream indexer hasn't surfaced the service yet (Max's case,
 *     the canonical #2207 cluster)
 *   - `unknown` — couldn't determine (HTTP error, non-JSON body,
 *     network failure, or no payTo extractable)
 *   - `not_applicable_non_cdp` — operator declared a non-CDP
 *     facilitator in their manifest; Bazaar indexing is CDP-only by
 *     design (Cryptor + Ferj correction 2026-05-21), so the absence
 *     is working-as-intended (per ADR-004 Pillar 3). Rolls up to
 *     `looks_correct`, NOT `upstream_issue`.
 *
 * v0.3.4+ deferred: `processing_fresh` vs `processing_stale`
 * distinction (requires settle-timestamp data x402trace doesn't
 * collect today without driving live settles or accepting
 * operator-supplied evidence via a future flag).
 */
export type IndexerState = "indexed" | "processing" | "unknown" | "not_applicable_non_cdp";

/**
 * X402-53 (L) — host_pollution facet on the host-pollution check.
 *
 * Surfaces a listing-hygiene warning when CDP's merchant discovery
 * returns the same resource path indexed under multiple hostnames for
 * a single payTo. Distinct from the upstream-stuck indexing class:
 * the operator's code is correct, but their CDN/Lambda answers
 * multiple hostnames and CDP captures the URL the buyer hit (not the
 * canonical resource URL), so the listing is leaky. ADR-008 records
 * the rationale (single-voice bypass under the D.5 precedent).
 *
 *   - `no_pollution` — merchant discovery returned ≥1 entry and no
 *     path appears on more than one host. Status: pass.
 *   - `polluted` — one or more resource paths each appear on >1 host
 *     in the merchant index. Status: info (warning, NOT a verdict
 *     change — `looks_correct` still rolls up to exit 0).
 *   - `not_applicable_non_cdp` — manifest declares non-CDP
 *     facilitator; CDP merchant discovery not consulted.
 *   - `unknown` — merchant discovery query failed (network, non-JSON
 *     body, or non-2xx). Don't fire the warning on uncertainty.
 */
export type HostPollutionState = "no_pollution" | "polluted" | "unknown" | "not_applicable_non_cdp";

export interface PollutedPath {
  /** Canonical resource path (e.g. `/v1/anchor`). */
  readonly resource_path: string;
  /** Hostnames (lowercased) under which this path is indexed; sorted ascending. */
  readonly hosts: readonly string[];
}

/**
 * X402-50 (K, ADR-007) — sub-cause discriminator on the
 * `upstream_stuck` verdict. Surfaces as `verdict.cause` on the
 * `BazaarVerdict.upstream_stuck` variant + `detail.upstream_stuck_cause`
 * on the indexing check's `CheckResult`.
 *
 *   - `payload_echo_gap` — at least one of K's two rules fired:
 *     Rule 1 (`payment_payload_missing_resource_object`) detected
 *     bare-string `paymentPayload.resource` in buyer-side capture,
 *     OR Rule 2 (`extensions_not_echoed`) detected the canonical
 *     `EXTENSION-RESPONSES: e30=` signature on /settle response with
 *     a non-empty challenge-side `extensions` declaration.
 *   - `indexer_state_processing` — bucket-2 / working-slow per
 *     @0xdespot's #2207 framing; indexing returned 0 resources.
 *   - `indexer_state_terminal` — bucket-3 / catalog never lands;
 *     indexing returned 404 (`not_found`-class).
 *   - `unknown` — default. Covers @AsaiShota's contrast case
 *     (payload-shape-correct, extensions echoed, still stuck) and
 *     any `upstream_stuck` verdict where K's input data wasn't
 *     available to diagnose the cause.
 *
 * Multi-endpoint synthesis (per ADR-007): when multiple endpoints
 * produce upstream_stuck, the top-level `cause` is the union; the
 * narrower causes (`indexer_state_*`) win over `unknown`; but
 * `payload_echo_gap` wins over the indexer-state classes (the echo
 * gap is upstream of the indexer state).
 */
export type UpstreamStuckCause =
  | "payload_echo_gap"
  | "indexer_state_processing"
  | "indexer_state_terminal"
  | "unknown";

/**
 * X402-50 (K, ADR-007) — buyer-side capture data needed for Rule 1
 * (`payment_payload_missing_resource_object`). When supplied (proxy
 * mode or fixture replay), Rule 1 evaluates the `resource` field
 * shape; when absent, Rule 1 defers (never fires false-positive).
 *
 * Per `PaymentPayloadV2Schema` in `@x402/core@2.11.0`
 * `schemas/index.d.mts:315-389`, `paymentPayload.resource` MUST be
 * `{ url, description?, mimeType? }` object. A bare URL string
 * triggers CDP HTTP 400 `'paymentPayload' is invalid` and skips
 * bazaar processing.
 */
export interface PaymentPayloadCapture {
  /** The full buyer-side payment payload as JSON, as sent to the facilitator. */
  readonly paymentPayload: Record<string, unknown>;
}

/**
 * X402-50 (K, ADR-007) — facilitator settle response capture needed
 * for Rule 2 (`extensions_not_echoed`). The canonical "extensions
 * not echoed" signature is the response header
 * `EXTENSION-RESPONSES: e30=` (base64 for `{}`). When supplied
 * alongside a non-empty challenge `extensions` block, the rule
 * detects the gap.
 */
export interface SettleResponseCapture {
  readonly status: number;
  /** Lowercased header name → value. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface HostPollutionFacet {
  readonly state: HostPollutionState;
  /** Only present when `state === "polluted"`. */
  readonly polluted_paths?: readonly PollutedPath[];
  readonly polluted_path_count?: number;
  /** Total entries returned by CDP merchant discovery. */
  readonly total_entries?: number;
  /** Distinct hostnames across all entries. */
  readonly distinct_hosts?: number;
}
