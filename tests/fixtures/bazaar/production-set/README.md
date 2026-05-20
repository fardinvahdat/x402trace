# Bazaar production-set fixtures

Real-world `bazaar-check` failure observations from third-party operators. Used as a regression bed for the v0.3.2 metadata-propagation sub-checks (D.1 / D.2 / D.3) and the JSON-API stability commitment.

## Provenance

### `tomsmart-2026-05-20.json`

19 endpoints sampled by [@TomSmart_ai](https://github.com/TomSmart_ai) (mapper operator, cdp-verified Coinbase Developer Discord) from his production catalog on 2026-05-20.

- **Methodology:** 20 endpoints sampled — 10 freshest, 5 CDP-sourced, 5 with on-chain payment volume. One skipped as obvious crawler junk, so 19 actually probed.
- **Tool version probed against:** v0.3.0 (the version published when the run was captured).
- **Verdict at capture:** 19 of 19 returned `implementation_issue`.
- **Significance:** First production-scale validation of the bazaar-check verdict taxonomy. TomSmart_ai's framing — *"yours is catching a much stricter listing-readiness gap that I wasn't even measuring — two different layers of the same lifecycle: yours pre-ship for builders, mine post-ship for agent discovery"* — became the canonical pitch language for the tool.

## Schema

Each fixture JSON file conforms to this shape:

```jsonc
{
  "source": {
    "contributor": "<github-or-discord-handle>",
    "context": "<where the data came from>",
    "methodology": "<how the sample was constructed>",
    "tool_version": "<x402trace version probed>",
    "captured_at": "<ISO-8601 date>",
    "summary": "<one-line aggregate verdict>"
  },
  "fixtures": [
    {
      "url": "<service URL probed>",
      "expected_verdict_at_capture": "looks_correct" | "implementation_issue" | "upstream_issue",
      "notes": "<optional caveats>" | null
    }
  ]
}
```

The structure is locked by `tests/unit/bazaar-production-fixture.test.ts` so v0.3.2 work doesn't accidentally drift the shape.

## How v0.3.2 work consumes this

The D.1 / D.2 / D.3 sub-checks land in v0.3.2:

- **D.1** — manifest hygiene (empty-string detection in `extensions.bazaar`)
- **D.2** — propagation diff (manifest vs indexer render)
- **D.3** — indexer-state probe (catches `processing → never indexed`)

Each sub-check should be exercised against this fixture set as part of its integration test, asserting that:

1. The aggregate verdict still resolves to the same top-level bucket (`implementation_issue` for all 19, **unless** a v0.3.2-specific sub-check legitimately reclassifies one to `upstream_issue` or a new `upstream_stuck` verdict).
2. Any reclassification is intentional and explained in the test + CHANGELOG.

This is the lock against accidentally regressing the verdict taxonomy when adding new sub-checks.

## Caveats — flagged for future maintainers

- The `lowpaymentfee.com/api/v1/{employees|stripe|medical|nfts}` cluster (entries `lowpaymentfee.com/*` in the JSON) has suspicious-looking path patterns (SSN, medical records, Stripe invoices). May be a test honeypot, a scam, or a real but poorly-designed service. **Do not** reuse these URLs as canonical examples in documentation without re-verifying they're operational and legitimate.
- These URLs were live in production on 2026-05-20. They may go stale, change verdict, or 404 over time. The fixtures encode the verdict **at time of capture**; new probes are expected to drift.

## Cross-references

- [v0.3.1+/v0.3.2 Notion plan](https://www.notion.so/36503c62b26381cfbd1ce4d95fabda82) — full evidence trail + scope tracking
- [Project memory `listing-readiness-framing.md`](https://github.com/fardinvahdat/x402trace) — TomSmart_ai's canonical pitch framing
- [Project memory `bazaar-indexing-spec.md`](https://github.com/fardinvahdat/x402trace) — the indexer contract bazaar-check validates against
- README Acknowledgments — TomSmart_ai listed alongside other v0.3.1 contributors
