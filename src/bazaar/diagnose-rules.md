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
| K rule pair (payment-payload echo gap) | — | `upstream_stuck.cause` discriminator on existing `upstream_stuck` verdict | X402-50 (ADR-007) |
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

### K rule pair (X402-50, ADR-007) — payment-payload echo gap

Two rules refine the `upstream_stuck` verdict with attribution. Both require buyer-side capture data (proxy mode or fixture replay); in standalone mode they defer.

**Rule 1: `payment_payload_missing_resource_object`**

Fires when `paymentPayload.resource` is a bare URL string instead of `{url, description?, mimeType?}` object. Per `PaymentPayloadV2Schema` in `@x402/core@2.11.0`, the object form is canonical; a bare string returns CDP HTTP 400 `'paymentPayload' is invalid` and skips bazaar processing.

```typescript
// ❌ Triggers Rule 1
paymentPayload.resource = "https://api.example.com/v1/x";

// ✓ Correct
paymentPayload.resource = {
  url: "https://api.example.com/v1/x",
  description: "Anchor endpoint",
  mimeType: "application/json",
};
```

**Rule 2: `extensions_not_echoed`**

Fires when both of these are true:
1. The /settle response carries `EXTENSION-RESPONSES: e30=` (base64 for `{}` — the canonical "extensions absent" signature).
2. The upstream 402 challenge declared a non-empty `extensions` block.

Both conditions are load-bearing. The `e30=` signature alone is not enough — bazaar-disabled services legitimately return `{}`. The challenge-side non-empty declaration is what makes the gap diagnosable as "bazaar opted in but the extensions weren't echoed back."

**`verdict.cause` precedence:**

1. `payload_echo_gap` if either rule fired.
2. `unknown` (capture-checked sentinel) when both rules ran and both returned false. This is @AsaiShota's contrast case (payload-correct, still stuck) — going to `unknown` instead of a narrower attribution prevents false-positive routing.
3. `indexer_state_processing` when K capture was NOT supplied AND indexer state is `processing`.
4. `unknown` otherwise.

**Reference implementation pattern (operator-side remediation):** see [@RipperMercs's tensorfeed `worker/src/cdp-facilitator.ts`](https://github.com/RipperMercs/tensorfeed/blob/main/worker/src/cdp-facilitator.ts). The canonical fix shape lives there + in-repo at `tests/fixtures/bazaar/captured-responses/agentoracle-upstream-stuck-body-discovery.json` (pre-fix) paired with the post-fix delta row from @TKCollective's contributed fixture.

**Contrast voice (false-positive sentinel):** `tests/fixtures/bazaar/captured-responses/test-echo-cdp-stuck-cause-unknown.json` is the canonical guard. Payload is well-formed, extensions echo properly, but the listing is still stuck. K rules must NOT route this to `payload_echo_gap`; the fixture asserts `verdict.cause === "unknown"`.

### `facilitator-fitness` (X402-51 / G, ADR-005)

Probes the merchant's declared facilitator(s) `/verify` endpoint and emits a per-rail fitness facet under `detail.facilitator_fitness`. Closes the v0.3.2 gap where `indexing.indexer_state: not_applicable_non_cdp` correctly avoided misattribution but offered no positive fitness signal for non-CDP services.

**Identity source: declared `extensions.bazaar.facilitator` field, NOT tx-`from` inference.** Load-bearing for gasless rails (SKALE+PayAI per TKCollective's fixture offer) where the buyer-side tx `from` is the gasless relayer, not the facilitator.

**Built-in registry** (`src/bazaar/facilitator-registry.json`) ships with three facilitators known to v0.3.4: CDP, PayAI, x402.org/facilitator. Unknown facilitators emit `facilitator_fitness: unknown` rather than attempting structural probing. New facilitators land as PRs adding entries to the registry.

**States (`FacilitatorFitnessState`):**

- `ok` — `/verify` returns 2xx within timeout, or 4xx (facilitator responsive; rejection of the malformed probe payload is expected). Status: pass.
- `degraded` — 5xx that recovers on retry within bounded backoff (500ms / 1s / 2s per the @mkmkkkkk #1065 pattern). Status: pass — facet surfaces but verdict not flipped.
- `unreachable` — consistent failure across all bounded retries (TCP refused / TLS error / persistent 5xx / timeout). Status: info → rolls up to `upstream_issue` verdict, exit 3.
- `unknown` — facilitator not in registry, or no declaration available, or no probe attempted.

**Facet shape (`detail.facilitator_fitness`):**

```typescript
{
  rails: Array<{
    rail: number;              // 0-indexed position in accepts[]
    network: string;           // e.g. "eip155:8453", "solana:..."
    facilitator: string | null;
    identity_source: "declared" | "inferred-from-tx" | "unknown";
    fitness: FacilitatorFitnessState;
    diagnostic?: string;
  }>;
  summary: { ok: number; degraded: number; unreachable: number; unknown: number };
}
```

**Multi-rail synthesis:** healthy rails are NOT masked by degraded/unreachable rails. Per-rail array is the canonical shape; downstream consumers (`anchor-x402` mapper, leaderboards) bucket on `summary.unreachable > 0`.

**v0.3.4 MVP scope:** manifest-level declaration applies to all rails uniformly (single probe per facilitator URL, cached for the run duration). Per-`accepts[i].facilitator` override deferred to v0.4+ if an operator surfaces the need.

**Probe protocol:** POST to `<facilitator>/verify` with a minimal, structurally-valid but signature-invalid payload (`{ probe: "x402trace-fitness", x402Version: 2 }`). Same surface a malformed buyer would hit; facilitators that accept normal traffic accept this. The probe tests reachability, not authorisation — 4xx responses are read as `ok` (facilitator is responsive).

**Cross-facet precedence** (per `src/bazaar/diagnose-rules.md`): `service_unreachable` (I, future) > `upstream_stuck.cause` (K) > `upstream_issue` (any-rail-unreachable here) > `facilitator_fitness.degraded` (facet only) > `host_pollution` (L) > `looks_correct`. A DNS-failing service skips the facilitator probe entirely once I's top-level verdict pre-empts.

Voices: @Cryptor (Discord 2026-05-21 — CDP-only-by-design correction), @TomSmart_ai (mapper integration consumer), @Cinderwright (#1065 PayAI alternative + 3s auto-retry workaround). Canonical multi-rail fixture: Ferj/@hypeprinter007-stack's `anchor-x402` (3 rails: Base USDC CDP + Solana USDC CDP + JPY Coin Polygon non-CDP).

### `reachability` (X402-52 / I, ADR-006)

Probes the service URL at the network layer (DNS / TCP / TLS / HTTP) with bounded timeout + bounded retry. Classifies the outcome into one of:

| State | Status | Cause | Verdict rollup |
|---|---|---|---|
| `ok` | pass | — | unchanged (does not affect verdict) |
| `unreachable_first_probe` | info | dns_failure / tcp_refused / tls_error / timeout | folds to existing `implementation_issue` / `upstream_issue` with INFO note — does NOT promote to top-level |
| `unreachable_first_probe` | info | persistent_5xx | folds to existing `upstream_issue` (server-malfunction, NOT unreachability) — never promotes to top-level |
| `unreachable` (consensus met) | info | dns_failure / tcp_refused / tls_error / timeout | **promotes to top-level `service_unreachable` verdict (exit 3)**, pre-empts all other checks |

**Multi-probe consensus is required for top-level promotion.** Single-probe failure emits the facet but does NOT fire `service_unreachable`. The verdict synthesizer reads `consensus_met` on the facet to discriminate.

Consensus requires N consecutive matching probes (default 3 via `--unreachable-consensus-count`) within the per-cause window. Per-cause window table (locked 2026-05-29 with @TomSmart_ai endorsement; reasoning in [aios/decisions/adr-006-probe-history-impl-notes-2026-05-29.md](../../aios/decisions/adr-006-probe-history-impl-notes-2026-05-29.md)):

| Cause | Default window | Rationale |
|---|---|---|
| `dns_failure` | 5 min | DNS TTLs are fast; NXDOMAIN-over-N-probes is the cleanest fastest-converging signal |
| `tcp_refused` | 15 min | Transient sources: LB reaping, deploy churn |
| `tls_error` | 30 min | TLS-1.3 / ALPN / cert rotation edge cases (per TomSmart's 6×200 TLS-handshake-fail-but-HTTP-recovers sample) |
| `timeout` | 15 min | Same transient class as `tcp_refused` |
| `persistent_5xx` | n/a (out-of-band) | Within ONE probe attempt's bounded retry loop (3 attempts at 500ms). Rolls to `upstream_issue`, not `service_unreachable` |

Operators scale all windows uniformly via `--unreachable-interval-multiplier <n>`. Per-cause individual flags deferred to v0.4+ if an operator surfaces the need.

**Probe-history state (the architectural shift):** v0.3.4's `reachability` is the **first stateful verdict** in x402trace. Prior verdicts (looks_correct / implementation_issue / upstream_issue / upstream_stuck / service_unreachable's single-probe path) were deterministic-per-probe — they only consumed data from the current `bazaar-check` invocation. Cross-probe consensus requires the engine to read prior probe state.

Resolved: **inline in JSONL log via the new `bazaar.probe_attempt` event discriminant** (see [src/decoder/schema.md](../decoder/schema.md)). Re-invocations of `bazaar-check --probe-history-log <file>` parse the same JSONL log the user already manages. External state directory (`~/.x402trace/probe-history/`) rejected — preserves the local-first stateless property and avoids stale-cache failure modes.

**Facet shape (`detail.reachability`):**

```typescript
{
  state: "ok" | "unreachable_first_probe" | "unreachable";
  unreachable_cause?: "dns_failure" | "tcp_refused" | "tls_error" | "timeout" | "persistent_5xx";
  probe_count: number;          // current + prior matching probes from log history
  consensus_threshold: number;  // configured threshold (default 3)
  consensus_met: boolean;       // true → verdict synthesizer promotes to service_unreachable
  diagnostic?: string;          // one-line outcome description
  consensus_window_ms?: number; // effective window applied (post-multiplier)
}
```

**Cross-facet precedence** (per the canonical chain documented at the top of this file):

```
service_unreachable (I) > upstream_stuck.cause (K) > upstream_issue > facilitator_fitness facet (G) > host_pollution facet (L) > looks_correct
```

A service that fails DNS doesn't reach the upstream surfaces K / G / L probe — those checks may emit info-status results, but the verdict synthesizer ignores them when reachability fires `service_unreachable`. Anti-pattern documented (per ADR-006): **don't key verdicts on third-party single-snapshot status fields** — third-party mapper status (e.g. TomSmart's mapper.db `status IS NULL or 0` from his 2026-05-28 traceroute, which showed 86.7% false-positive rate) is stale by design. Always use multi-probe consensus from x402trace's own probes.

**Probe protocol:** GET to `serviceUrl` with bounded timeout (default 10s). On 2xx/3xx/4xx → `ok` (service responsive; probe-payload-rejection is expected for unauthenticated GET on x402 endpoints — they return 402). On 5xx → retry up to 3 attempts within the probe; 3 consecutive 5xx → `persistent_5xx`. On network error → classify via `classifyFetchError` against the underlying error code (`ENOTFOUND`, `ECONNREFUSED`, `CERT_*`, `EPROTO`, `AbortError`).

Voices: divigent probe (2026-05-23, DNS-fail real example) + @TomSmart_ai (mapper.db cohort evidence + 2026-05-28 traceroute anti-evidence that reshaped the AC). @AsaiShota's test-echo-cdp as the false-positive sentinel (payload-correct, indexed, reachable → must NOT mis-classify).

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
