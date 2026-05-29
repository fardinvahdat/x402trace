# bazaar-check diagnose rules

The `bazaar-check` command runs a sequence of independent checks against
the operator's service and synthesises a single verdict. Each check
emits a `CheckResult` with a stable `check` identifier, a status
(`pass | fail | info`), a one-line message, and an optional structured
`detail` facet.

This file documents the rule patterns each check implements and the
anti-patterns to avoid when designing new rules. ADRs are the
authoritative spec for the rule itself; this file is the
implementation companion.

## Check inventory

| Check | Status emitted | Verdict impact | ADR |
|---|---|---|---|
| `well-known` | pass / fail | implementation_issue on fail | X402-32 |
| `challenge` | pass / fail | implementation_issue on fail | X402-32 |
| `self-payment` | pass / fail | implementation_issue on fail | X402-32 |
| `indexing` | pass / info | upstream_stuck or upstream_issue on info | X402-46 (ADR-004) |
| `propagation` | pass / info | upstream_issue on info | X402-45 (ADR-004) |
| `host-pollution` | pass / info | none — warning, not a verdict change | X402-53 (ADR-008) |
| `facilitator-fitness` (v0.3.4) | pass / info | upstream_issue on info per rail | X402-51 (ADR-005) |
| `reachability` (v0.3.4) | pass / info | service_unreachable when consensus met | X402-52 (ADR-006) |

Cross-facet precedence (per ADR-006):

```
service_unreachable
  > upstream_stuck (with upstream_stuck_cause: payload_echo_gap from K)
    > upstream_issue
      > facilitator_fitness facet on looks_correct
        > host_pollution facet on looks_correct
          > looks_correct
```

A service that fails DNS doesn't get an `upstream_stuck_cause` because
it never reached the upstream surfaces those probe. A service with
multi-host pollution AND a working facilitator still rolls up to
`looks_correct` — both facets surface alongside the verdict.

## Anti-patterns

### Don't key verdicts on third-party single-snapshot status fields

Source: TomSmart_ai's 2026-05-28 traceroute analysis. ADR-006 § Context.

**Don't do this:**

```typescript
// ❌ WRONG — single-snapshot status from mapper.db, agentic.market,
// or any third-party indexer
if (thirdPartyIndexer.status === 0 || thirdPartyIndexer.status === null) {
  emit("service_unreachable");
}
```

Third-party single-field status lags endpoint churn. Per
@TomSmart_ai's traceroute, **13/15 (86.7%) of mapper.db-labeled-
unreachable endpoints were actually HTTP-reachable on re-probe**. The
status field reflects historical state, not current.

**Do this instead** (when X402-52 lands):

```typescript
// ✓ CORRECT — multi-probe consensus + failure-mode classification
const history = readProbeHistory(logPath, serviceUrl, 3);
if (
  consensusReached(
    history,
    /*threshold=*/ 3,
    /*windowMs=*/ 30 * 60 * 1000,
    "dns_failure",
  )
) {
  emit("service_unreachable", { unreachable_cause: "dns_failure" });
}
```

The persistent-NXDOMAIN-over-N-probes subset IS clean — ship that
first.

References:

- TomSmart's gist: https://gist.github.com/smartflowproai-lang/c57ae6e5aaeaf038e60ce76312d1283a
- Memory: [[service-unreachable-rule-anti-evidence]]

### Don't treat additive facets as verdict-changing

Source: ADR-008 (host_pollution).

The `host-pollution` check returns `status: "info"` when it finds
multi-host pollution, but the verdict synthesizer **does not** include
`host-pollution` in its `UPSTREAM_CHECKS` set. The implication:

- Operator's code passes all technical checks → verdict = `looks_correct`
- Merchant discovery shows pollution → `host_pollution` facet fires
- Exit code stays `0`; downstream consumers read the facet for the
  warning

This pattern keeps the exit-code surface a three-value contract per
ADR-004 Pillar 2 (preserves CI integrations) while still letting
operators surface listing-hygiene gaps in their tooling.

When adding new check types, decide explicitly: is this rule
**verdict-changing** (folds into the existing three-value exit code)
or **warning-only** (emits a facet but rolls up to `looks_correct`)?
The default for v0.3.4+ refinements is warning-only unless the rule
represents a CI-stopping failure class.

### Don't infer facilitator identity from on-chain `from` address

Source: ADR-005 (G facilitator-fitness).

Some rails are gasless (e.g., SKALE + PayAI per @TKCollective's
2026-05-27 fixture offer). On those rails, the buyer-side tx `from`
matches the gasless relayer's address, not the facilitator's.
Inferring facilitator identity from tx `from` mis-identifies on
gasless rails.

**Do this instead:** read the declared `extensions.bazaar.facilitator`
field directly from the operator's manifest. tx-`from` inference is
reserved as a last-resort fallback for non-gasless rails only, and
only when the manifest declares no facilitator at all.

## Documented checks

### `well-known` (X402-32)

Fetches `/.well-known/x402` and validates the manifest shape. Fails on
HTTP error, non-JSON body, missing required fields (`name`,
`description`, `accepts[]`).

Variant-aware since v0.3.2 D.5 (X402-43): the check branches on
`BodyDiscoveryExtension` vs `McpDiscoveryExtension` shapes via the
`extensions-bazaar.ts` validator. Body-discovery services are valid
without top-level `name` / `description`; MCP-discovery services
require them.

### `challenge` (X402-32)

Fetches the 402 challenge from the service URL (or the `--endpoint`
URL when X402-42 / D.4 mode is active) and validates the
`extensions.bazaar` block. Fails on non-402 status, non-JSON body,
missing `accepts[]` entry, or shape-invalid `extensions.bazaar`.

### `self-payment` (X402-32)

Guards against the operator pointing the check at their own payTo
when supplying `--payer-hint`. Fails if `payerHint === payTo`.

### `indexing` (X402-46 / D.3, ADR-004)

Queries `/v2/x402/discovery/resources?payTo=<addr>` and classifies the
result into an `IndexerState`:

- `indexed` — ≥1 resource visible. Status: pass.
- `processing` — 404 or empty resources. Status: info. Rolls up to
  `upstream_stuck` verdict via the verdict synthesizer (X402-46).
- `unknown` — HTTP error / non-JSON. Status: info → `upstream_issue`.
- `not_applicable_non_cdp` — manifest declares non-CDP facilitator.
  Status: pass. WAI per ADR-004 Pillar 3.

### `propagation` (X402-45 / D.2, ADR-004)

Diffs `name` and `description` between the manifest and the indexer's
rendered fields for the same payTo. Surfaces the @zev / TheRoosters /
GM pattern: manifest correct, indexer dropped fields, listing
renders blank.

States: `ok` (pass), `partial` / `missing` (info → `upstream_issue`),
`unknown` (pass), `not_applicable_non_cdp` (pass).

### `host-pollution` (X402-53 / L, ADR-008)

Queries `/platform/v2/x402/discovery/merchant?payTo=<addr>&limit=50`
and groups returned resource URLs by `(host, path)`. Fires a warning
when any canonical path appears under more than one host for the same
payTo.

States (`HostPollutionState`):

- `no_pollution` — merchant discovery returned ≥1 entry and no path
  is multi-host. Status: pass.
- `polluted` — one or more paths each appear on >1 host. Status:
  info. **Warning only — does NOT change the verdict.** Exit code
  unchanged.
- `not_applicable_non_cdp` — manifest declares non-CDP facilitator.
  Status: pass.
- `unknown` — merchant discovery query failed. Status: pass. Don't
  fire the warning on uncertainty.

Facet shape (`detail.host_pollution`):

```typescript
{
  state: "no_pollution" | "polluted" | "not_applicable_non_cdp" | "unknown";
  polluted_paths?: Array<{ resource_path: string; hosts: string[] }>;
  polluted_path_count?: number;
  total_entries?: number;
  distinct_hosts?: number;
}
```

Canonical operator case: @hypeprinter007-stack / Ferj's
`anchor-x402.com` setup. 25 entries for one payTo spread across 3
hosts (`api.anchor-x402.com`, `chat.anchor-x402.com`,
`1c09pdnrx1.execute-api.us-east-1.amazonaws.com`); 9 resource paths
each indexed on 2+ hosts. Captured-response fixture:
`tests/fixtures/bazaar/captured-responses/anchor-x402-host-pollution.json`.

### `facilitator-fitness` (X402-51 / G, ADR-005) — pending implementation

Will probe declared facilitator(s) per rail (built-in registry:
CDP, PayAI, x402.org/facilitator). Per-rail facet array under
`detail.facilitator_fitness`. Healthy CDP rails are NOT masked by
degraded non-CDP rails. Identity source: declared
`extensions.bazaar.facilitator` field, NOT tx-`from` inference.

### `reachability` (X402-52 / I, ADR-006) — pending implementation

Will run multi-probe reachability tests against the service URL.
Top-level `service_unreachable` verdict fires only when N consecutive
probes (default 3, spaced ≥5 min) all fail with the same
failure-mode. Single-probe failure emits the facet under existing
`implementation_issue` with an INFO note. Probe-history state inlined
in JSONL log via new `bazaar.probe_attempt` event discriminant.

## Adding a new diagnose rule

Checklist for v0.3.4+ additions:

1. Write the ADR first (template in `DECISIONS.md`). Include the
   rationale, the named-voice promotion basis, and the rejected
   alternatives.
2. Decide: verdict-changing or warning-only? Default warning-only.
3. Decide: top-level discriminator addition or facet under existing
   verdict? Default facet (preserves JSON API stability per X402-44).
4. Add the facet type to `src/bazaar/types.ts`.
5. Implement the check module in `src/bazaar/<check-name>.ts`.
   Pattern: pure detection function + `check<Name>` wrapper that
   handles fetching + state mapping.
6. Wire into `src/bazaar/index.ts`. Append to results (additive); do
   not reorder existing checks.
7. Update `src/bazaar/verdict.ts` only if the rule is
   verdict-changing.
8. Update `src/bazaar/json-api.md` with the new facet shape.
9. Regenerate the JSON API snapshot:
   `pnpm tsx tests/fixtures/bazaar/regenerate-json-api-snapshot.ts`
10. Write unit tests in `tests/unit/bazaar-<check-name>.test.ts`.
11. Add a captured-response fixture in
    `tests/fixtures/bazaar/captured-responses/<scenario>.json` (the
    integration harness auto-picks it up).
12. Add CHANGELOG entry under `### Added` for the upcoming release.
13. Bump publish-surface cap if needed
    (`scripts/check-publish-surface.mjs`).
14. Run the strict 6-stage audit gate from `CLAUDE.md` § "Strict
    audit gate".
