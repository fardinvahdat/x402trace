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

## `results[]` — the four checks

Always four entries, in this fixed order:

1. `"well-known"` — root `/.well-known/x402` manifest probe
2. `"challenge"` — 402 challenge structure probe (uses `--endpoint` URL when supplied)
3. `"self-payment"` — payer ≠ payTo guard (informational when `--payer-hint` absent)
4. `"indexing"` — CDP discovery query

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

| Check       | Detail keys                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------- |
| `well-known` | `issues[]` (when status=fail), `httpStatus` (when status=fail and HTTP error)              |
| `challenge`  | `httpStatus` (when fetch fails), `missingFields[]` + `variant` (when extensions.bazaar fail) |
| `self-payment` | (no detail fields today)                                                                   |
| `indexing`   | `queryUrl`, `status` (one of `"indexed" \| "processing" \| "not_found" \| "error"`), `count` (when indexed), `httpStatus` (when HTTP error) |

The `challenge.detail.variant` field carries the detected discovery-extension variant (`"mcp-discovery"` \| `"body-discovery"` \| `"unknown"`) on failed validations. See ADR-004 Pillar 3 for the variant model.

## `verdict` — the discriminated union

```jsonc
{
  "kind": "looks_correct" | "implementation_issue" | "upstream_issue",
  "exitCode": 0 | 2 | 3,
  "message": "...",
  // Per-kind additional fields:
  "failedChecks": [...]      // ONLY on "implementation_issue"
  "upstreamChecks": [...]    // ONLY on "upstream_issue"
}
```

### Exit-code contract (preserved unchanged across all minor versions)

- `0` ↔ `looks_correct`
- `2` ↔ `implementation_issue`
- `3` ↔ `upstream_issue`

D.3's `upstream_stuck` composite (from ADR-004 Pillar 1, landing in X402-46) rolls up to exit code 3 — the verdict prose names the distinction; the exit-code surface stays a 3-value contract. Consumers grepping exit codes don't break.

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

When the JSON shape is intentionally changing (additive OR shape-breaking), regenerate the fixture:

```bash
# Option A — hand-edit if you know the exact new shape
$EDITOR tests/fixtures/bazaar/json-api-snapshot.json

# Option B — capture from a live deterministic run (recommended)
pnpm tsx -e '
  import { runBazaarCheck } from "./src/bazaar/index.js";
  // ... wire up the deterministic fetcher from the test file ...
  const report = await runBazaarCheck({...});
  console.log(JSON.stringify(report, null, 2));
' > tests/fixtures/bazaar/json-api-snapshot.json
```

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
