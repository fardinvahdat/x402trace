# Captured-response fixtures for bazaar-check end-to-end coverage

X402-47 — hand-rolled fixtures that exercise the D.2 / D.3 / D.5 verdict
facets end-to-end via `runBazaarCheck` without needing live HTTP.

Each `.json` file in this directory is **self-describing**: it carries
the input config + the three mock responses (well-known, challenge,
discovery) + the expected verdict + key facet values. The integration
test at [`tests/integration/bazaar-check-captured-responses.test.ts`](../../../integration/bazaar-check-captured-responses.test.ts)
iterates over every fixture and runs the full check pipeline against
the captured responses.

## Why captured responses, not live URLs

The pre-committed contributor fixtures (TomSmart's cdp-mature, AsaiShota's
test-echo-cdp, evanatpizzarobot's TensorFeed, 0xdespot's hyperD,
hypeprinter007's anchor-x402) are real production services. Running
bazaar-check against them live is slow, flaky, and gated on those
services being up. The fixture bed in `production-set/` captures their
URL lists + expected-at-capture verdicts as schema-only structural
contracts.

This directory takes the opposite approach: tiny **hand-rolled**
captured responses that exercise specific verdict-synthesis paths
deterministically. Each fixture isolates one D.x failure mode.

When live contributor fixtures arrive (Sunday 2026-05-24 TomSmart drop;
others rolling), they wire into `production-set/` as URL+verdict pairs
for structural assertion, while this `captured-responses/` directory
keeps the end-to-end behavioral coverage hermetic.

## Fixture schema

```jsonc
{
  "$comment": "Short one-line description of what this fixture exercises",
  "scenario": "<stable-slug>",                  // matches the file basename
  "input": {
    "serviceUrl": "https://...",                  // service URL passed to bazaar-check
    "chain": "base-sepolia" | "base"
  },
  "mocks": {
    "well-known": { "status": 200, "body": {...} },     // response from /.well-known/x402
    "challenge":  { "status": 402, "body": {...} },     // response from the service URL
    "discovery":  { "status": 200, "body": {...} }      // response from CDP discovery
  },
  "expected": {
    "verdict": "looks_correct" | "implementation_issue" | "upstream_issue" | "upstream_stuck",
    "exitCode": 0 | 2 | 3,
    "facets": {                                  // optional; per-check detail facets to assert
      "<check>.<facet>": <value>
    }
  }
}
```

## Existing fixtures

| File | Exercises |
|---|---|
| `d2-missing-propagation.json` | D.2 `metadata_propagation: missing` (the @zev / TheRoosters / GM pattern) |
| `d3-processing-stuck.json` | D.3 `indexer_state: processing` → `upstream_stuck` verdict (Max's polyodds.bet pattern) |
| `d5-body-discovery.json` | D.5 BodyDiscoveryExtension variant → no false-positive `implementation_issue` (AsaiShota's test-echo-cdp pattern) |

## Adding a new fixture

1. Drop a `<scenario-slug>.json` here following the schema above
2. Re-run `pnpm test tests/integration/bazaar-check-captured-responses.test.ts`; the new file is picked up automatically
3. If the new fixture exercises a verdict combination the harness doesn't know how to assert yet, extend the harness in `tests/integration/bazaar-check-captured-responses.test.ts`
