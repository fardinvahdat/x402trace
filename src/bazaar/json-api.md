# `bazaar-check --log json` — Public JSON API contract

This document is the **public API contract** for `bazaar-check --log json` output. Downstream consumers (TomSmart_ai's mapper-integration, agent-side filters, future bazaar-aware tools) take a runtime dependency on the shape described here. Per [ADR-004 Pillar 2](../../DECISIONS.md), the maintainer commits to the stability rules below.

The frozen exemplar lives at [`tests/fixtures/bazaar/json-api-snapshot.json`](../../tests/fixtures/bazaar/json-api-snapshot.json); the test that enforces it lives at [`tests/integration/bazaar-check-json-api.test.ts`](../../tests/integration/bazaar-check-json-api.test.ts).

## Envelope

A single JSON object per `bazaar-check` invocation, written to stdout when `--log json` is supplied. Four top-level keys, in this order:

```jsonc
{
  "serviceUrl": "https://...",   // string — the service URL the run targets
  "chain": "base-sepolia",        // "base-sepolia" | "base"
  "results": [...],               // CheckResult[] — exactly 4 entries
  "verdict": {...}                // BazaarVerdict — discriminated union
}
```

## `results[]` — the canonical checks

Entries appear in this fixed order. New checks are appended (never reordered):

1. `"well-known"` — root `/.well-known/x402` manifest probe
2. `"challenge"` — 402 challenge structure probe (uses `--endpoint` URL when supplied)
3. `"self-payment"` — payer ≠ payTo guard (informational when `--payer-hint` absent)
4. `"indexing"` — CDP discovery query (`/v2/x402/discovery/resources?payTo=...`)
5. `"propagation"` — metadata propagation diff (X402-45 / D.2, ADR-004)
6. `"host-pollution"` — CDP merchant discovery multi-host listing-hygiene warning (X402-53 / L, ADR-008)
7. `"facilitator-fitness"` — declared facilitator `/verify` probe with per-rail facet array (X402-51 / G, ADR-005)

Each entry is a `CheckResult`:

```jsonc
{
  "check": "well-known",          // stable identifier; downstream tools grep/filter on this
  "status": "pass" | "fail" | "info",
  "message": "...",               // one-line human-readable description
  "fix": "...",                   // OPTIONAL — present when status is "fail" or "info"
  "detail": { ... }               // OPTIONAL — per-check structured detail
}
```

### `status` semantics

- **`pass`** — the check found no issue in your implementation
- **`fail`** — the check found a concrete issue you can fix
- **`info`** — the check observed an upstream-bound signal that is NOT your fault but worth surfacing (e.g. CDP indexing stuck on "processing" — the canonical [#2207](https://github.com/x402-foundation/x402/issues/2207) pattern)

### `detail` fields per check (additive over time)

These fields are present when the check fires the corresponding code path. Consumers should treat `detail` as additive — never assume absence means "not applicable"; always check for key presence.

| Check            | Detail keys                                                                                                                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `well-known`     | `issues[]` (when status=fail), `httpStatus` (when status=fail and HTTP error)                                                                                                                                        |
| `challenge`      | `httpStatus` (when fetch fails), `missingFields[]` + `variant` (when extensions.bazaar fail)                                                                                                                         |
| `self-payment`   | (no detail fields today)                                                                                                                                                                                             |
| `indexing`       | `queryUrl`, `status` (one of `"indexed" \| "processing" \| "not_found" \| "error"`), `count` (when indexed), `httpStatus` (when HTTP error), `indexer_state` (`"indexed" \| "processing" \| "unknown" \| "not_applicable_non_cdp"`) |
| `propagation`    | `queryUrl`, `metadata_propagation` (`"ok" \| "partial" \| "missing" \| "unknown" \| "not_applicable_non_cdp"`), `diff[]` (when partial/missing), `httpStatus` (when HTTP error)                                                                |
| `host-pollution` | `queryUrl`, `state` (`"no_pollution" \| "polluted" \| "unknown" \| "not_applicable_non_cdp"`), `polluted_paths[]` (when polluted), `polluted_path_count` (when polluted), `total_entries`, `distinct_hosts`, `httpStatus` (when HTTP error)            |
| `facilitator-fitness` | `facilitator_fitness.rails[]` (per-rail array: `{rail, network, facilitator, identity_source, fitness, diagnostic?}`), `facilitator_fitness.summary` (`{ok, degraded, unreachable, unknown}` counts) |

The `challenge.detail.variant` field carries the detected discovery-extension variant (`"mcp-discovery"` \| `"body-discovery"` \| `"unknown"`) on failed validations. See ADR-004 Pillar 3 for the variant model.

### `host-pollution` facet shape (X402-53 / L, ADR-008)

The `host-pollution` check returns `status: "info"` when CDP's merchant discovery (`/platform/v2/x402/discovery/merchant?payTo=<addr>&limit=50`) shows the same resource path indexed under more than one hostname for the operator's payTo. **The verdict synthesizer does NOT include `host-pollution` in its upstream-checks set** — `looks_correct` continues to roll up to exit code 0 even when this facet fires. Code is correct; ops are leaky.

When `state === "polluted"`, the facet carries:

```jsonc
{
  "state": "polluted",
  "polluted_paths": [
    {
      "resource_path": "/v1/anchor",
      "hosts": ["api.example.com", "gateway.example.com"]
    }
    // ... more polluted paths, sorted ascending by resource_path; hosts sorted ascending per entry
  ],
  "polluted_path_count": 9,
  "total_entries": 25,
  "distinct_hosts": 3
}
```

Operator remediation: configure CDN/Lambda to canonicalize to one host. CDP captures the URL the buyer hit (not the canonical resource URL), so when multiple hostnames front the same handler, the merchant index shows duplicate entries per path. See [ADR-008](../../DECISIONS.md#adr-008) for the design rationale.

### `facilitator-fitness` facet shape (X402-51 / G, ADR-005)

The `facilitator-fitness` check probes the merchant's declared `extensions.bazaar.facilitator` against the built-in registry (CDP, PayAI, x402.org/facilitator) and emits a per-rail array. Status `info` only when at least one rail is `unreachable` (rolls up to `upstream_issue` exit 3); `pass` otherwise — `degraded` rails surface in the facet but don't flip the verdict.

```jsonc
{
  "facilitator_fitness": {
    "rails": [
      {
        "rail": 0,
        "network": "eip155:8453",          // CAIP-2 chain identifier from accepts[i].network
        "facilitator": "cdp",               // declared value (or null)
        "identity_source": "declared",      // "declared" | "inferred-from-tx" | "unknown"
        "fitness": "ok",                    // "ok" | "degraded" | "unreachable" | "unknown"
        "diagnostic": "2xx on first attempt (45ms)"
      }
      // ... one entry per accepts[] rail
    ],
    "summary": { "ok": 3, "degraded": 0, "unreachable": 0, "unknown": 0 }
  }
}
```

Per-rail array is canonical — healthy CDP rails are NOT masked by degraded/unreachable rails. Downstream consumers (TomSmart_ai's mapper, Cinderwright's leaderboard) bucket on `summary.unreachable > 0`.

**Identity source attribution** (`identity_source` field): `declared` means the facilitator was read from `manifest.extensions.bazaar.facilitator`; `inferred-from-tx` is reserved for v0.4+ tx-`from` fallback (not used in v0.3.4); `unknown` means no declaration available (manifest absent or facilitator field absent).

**v0.3.4 MVP**: manifest-level declaration applies uniformly to all rails; per-`accepts[i].facilitator` override deferred to v0.4+ if an operator surfaces the need. See [ADR-005](../../DECISIONS.md#adr-005) for the design rationale.

## `verdict` — the discriminated union

```jsonc
{
  "kind": "looks_correct" | "implementation_issue" | "upstream_issue" | "upstream_stuck",
  "exitCode": 0 | 2 | 3,
  "message": "...",
  // Per-kind additional fields:
  "failedChecks": [...]      // ONLY on "implementation_issue"
  "upstreamChecks": [...]    // ONLY on "upstream_issue" and "upstream_stuck"
  "cause": "payload_echo_gap" | "indexer_state_processing" | "indexer_state_terminal" | "unknown"
                             // ONLY on "upstream_stuck" (X402-50 K, ADR-007)
}
```

### `verdict.cause` (X402-50 K, ADR-007)

Present only on the `upstream_stuck` variant. Refines the verdict with attribution to a specific root cause for the stuck-listing pattern. The exit-code surface is unchanged — `upstream_stuck` still rolls up to exit 3; `cause` is additive JSON-side, used by downstream consumers to bucket stuck listings without re-implementing the payload introspection.

| Cause value | Meaning |
|---|---|
| `payload_echo_gap` | At least one of K's two rules fired. Rule 1 (`payment_payload_missing_resource_object`) detected a bare-URL-string `paymentPayload.resource` in buyer-side capture, OR Rule 2 (`extensions_not_echoed`) detected the canonical `EXTENSION-RESPONSES: e30=` signature on /settle alongside a non-empty challenge-side extensions block. Canonical writeup: x402-foundation/x402#2207. |
| `indexer_state_processing` | The indexer state classification (`indexing.detail.indexer_state`) is `processing`, AND K rules' capture data was NOT fully supplied. This is the v0.3.2 baseline path — without buyer-side capture, the indexer state is the best signal we have. |
| `indexer_state_terminal` | Reserved for a future refinement. v0.3.4 doesn't distinguish processing-fresh vs processing-stale (requires settle-timestamp data x402trace doesn't collect today). |
| `unknown` | Default conservative fallback. Two scenarios: (a) K capture data WAS supplied for both rules AND both returned false — capture-checked sentinel ("not K, can't attribute further"); (b) catch-all for anything else. The `unknown` value covers @AsaiShota's contrast case (payload-correct, extensions echoed, still stuck — guards K's attribution precision from over-claiming). |

### K-rule capture inputs (proxy / fixture-replay only)

The K rules require buyer-side data that `bazaar-check` does NOT collect in standalone mode:

- **Rule 1** needs the signed `paymentPayload`. In standalone mode, the rule defers (never fires false-positive).
- **Rule 2** needs the /settle response headers. In standalone mode, the rule defers.

Capture sources:

- **Proxy mode** (future) — when bazaar-check is integrated with the local proxy substrate, captures pipe through automatically.
- **Fixture replay** — `tests/fixtures/bazaar/captured-responses/*.json` accepts optional `mocks.paymentPayload` + `mocks.settle` blocks that simulate the buyer-side data.

When both rules defer (no capture supplied), `verdict.cause` falls back to `indexer_state_processing` (when applicable) or `unknown`. Operators in standalone mode see the indexer-state-derived attribution; operators with proxy capture see the full K diagnosis.

### Exit-code contract (preserved unchanged across all minor versions)

- `0` ↔ `looks_correct`
- `2` ↔ `implementation_issue`
- `3` ↔ `upstream_issue` OR `upstream_stuck` (both fold to exit 3)

D.3's `upstream_stuck` composite (from ADR-004 Pillar 1, landing in X402-46) rolls up to exit code 3 — the verdict prose names the distinction; the exit-code surface stays a 3-value contract. K's `cause` discriminator (ADR-007 / X402-50) is additive JSON-side; the exit-code surface still stays a 3-value contract. Consumers grepping exit codes don't break.

## Stability rules

Per [ADR-004 Pillar 2](../../DECISIONS.md):

### ✅ Additive changes — ship in MINOR versions

- New OPTIONAL fields at any level (e.g. `verdict.severity`, `results[].detail.warningHint`)
- New CHECK names (e.g. a 5th check beyond the canonical 4)
- New `verdict.kind` discriminator values (e.g. `upstream_stuck` per D.3)
- New `detail.*` keys on existing checks (e.g. `indexer_state` for D.3)
- New OPTIONAL top-level fields

CHANGELOG `### JSON API` entry required even for additive changes — downstream consumers track the shape, not just behavior.

### 🚫 Shape-breaking changes — require a MAJOR version + integrator notice

- Field RENAMES (`verdict.kind` → `verdict.type`)
- Field REMOVALS
- Type changes (`exitCode: number` → `exitCode: string`)
- REORDERING of fixed-position fields (results array order, top-level key order)
- Removing a `verdict.kind` value
- Removing a CHECK name

Pre-major-bump steps:

1. Open a deprecation issue, comment for at least 2 weeks
2. Notify named downstream consumers (TomSmart_ai's mapper, etc.) via DM
3. Cut a deprecation release that emits BOTH old and new shapes side-by-side under a feature flag, if the affected consumers can't update quickly
4. Major version bump + CHANGELOG `### JSON API` entry with migration notes

## Regenerating the snapshot fixture

When the JSON shape is intentionally changing (additive OR shape-breaking), regenerate the fixture using the dedicated script:

```bash
pnpm tsx tests/fixtures/bazaar/regenerate-json-api-snapshot.ts
```

The script wires up the same deterministic fetcher used by the test, runs `runBazaarCheck`, and writes the result to `tests/fixtures/bazaar/json-api-snapshot.json`. Keep the script's fetcher in lockstep with the test's `deterministicFetcher` — if you add a new mock URL pattern in the test, mirror it in the script.

Then add a `### JSON API` entry to `CHANGELOG.md` `[Unreleased]` documenting:

- What field(s) changed (added / renamed / removed)
- Whether the change is additive (minor) or shape-breaking (major)
- Migration notes if shape-breaking

## Worked example

Running `bazaar-check https://api.example.test/api/snapshot --log json` against a service that passes all four checks produces the fixture in [`tests/fixtures/bazaar/json-api-snapshot.json`](../../tests/fixtures/bazaar/json-api-snapshot.json) verbatim.

When `--endpoint <paid-url>` is supplied, the `well-known` slot keeps the same shape but carries a different `message`:

```jsonc
{
  "check": "well-known",
  "status": "pass",
  "message": "skipped per --endpoint (probing <url> directly instead of /.well-known/x402)"
}
```

The four-result envelope shape is preserved — the well-known slot's `message` field is the only carrier of the skip signal. This is additive per Pillar 2 (no fields changed; only `message` content differs).
