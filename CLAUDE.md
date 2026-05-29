# CLAUDE.md — Operating manual for x402trace

This file is read by Claude Code at the start of every session. Keep it current; it is the project's living memory.

## Project mission

**x402trace** is a local CLI for debugging [x402](https://x402.org) payment flows on Base. Its first job is detecting **timeout reconciliation failures** — cases where the facilitator times out but the on-chain transaction settled anyway, leaving the wallet debited and the user with no recovery path.

Canonical reference: [coinbase/x402 Issue #1062](https://github.com/coinbase/x402/issues/1062).

## Status

- **Phase:** **v0.3.3 SHIPPED to npm** (rename of v0.3.2.1 fast-follow, semver compliance). v0.3.2 ([`x402trace@0.3.2`](https://www.npmjs.com/package/x402trace), Sigstore provenance + signed attestations) external adoption confirmed: @0xdespot ran `npx -y x402trace@0.3.2 bazaar-check` against hyperD 2026-05-23, @poteshniy (AgentTrust) shipped derivative `/v1/reputation` product 2026-05-26, @RipperMercs + @TKCollective ran v0.3.2 verdicts in [#2207](https://github.com/x402-foundation/x402/issues/2207) closure loop 2026-05-26. **v0.3.4 committed scope (4 items, 2026-05-29 update):** candidate_K filed as [X402-50](https://vahdatfardin.atlassian.net/browse/X402-50) (payment-payload echo gap diagnose rules — @RipperMercs + @TKCollective, 2 voices, ADR-007) + candidate_G ([X402-51](https://vahdatfardin.atlassian.net/browse/X402-51) facilitator-fitness — Cryptor + TomSmart + @Cinderwright 3rd-touch via x402-foundation/x402#1065 PayAI workaround 2026-05-29, ADR-005 accepted 2026-05-29) + candidate_I ([X402-52](https://vahdatfardin.atlassian.net/browse/X402-52) [#88](https://github.com/fardinvahdat/x402trace/issues/88) network-layer-fail vs x402-layer-fail — TomSmart mapper.db, 2 voices; **AC reshaped 2026-05-29** per TomSmart Tuesday-traceroute anti-evidence — 13/15 sampled cohort actually reachable; multi-probe consensus + DNS/TCP/TLS failure-mode classification required, ADR-006 accepted 2026-05-29 — top-level `service_unreachable` verdict + probe-history-via-JSONL state) + **candidate_L promoted 2026-05-29 via D.5 single-voice bypass ([ADR-008](./DECISIONS.md#adr-008-v034-l--host_pollution-listing-hygiene-verdict-single-voice-bypass-under-d5-precedent)): host_pollution listing-hygiene verdict — Ferj cdp-verified, anchor-x402.com 23-entry curl repro 2026-05-27**, renamed H→L because H taken by RipperMercs #85 directory-only-manifest signal in Notion plan. Jira [X402-53](https://vahdatfardin.atlassian.net/browse/X402-53) filed + Notion plan row added 2026-05-29. **Forward direction:** hosted-product play converges into comprehensive agentic-commerce super-app at https://deagentic.ai/ (see [[deagentic-super-app-vision]]) — recalibrates Candidate E from standalone hosted-demo to super-app component. v0.3.2 cycle shipped seven D.x + infrastructure tickets 2026-05-21 → 2026-05-22: [X402-41](https://vahdatfardin.atlassian.net/browse/X402-41) ADR-004 + [X402-42](https://vahdatfardin.atlassian.net/browse/X402-42) D.4 `--endpoint` + [X402-43](https://vahdatfardin.atlassian.net/browse/X402-43) D.5 variant-aware extensions.bazaar + [X402-44](https://vahdatfardin.atlassian.net/browse/X402-44) JSON API stability + [X402-45](https://vahdatfardin.atlassian.net/browse/X402-45) D.2 propagation diff + [X402-46](https://vahdatfardin.atlassian.net/browse/X402-46) D.3 indexer-state + `upstream_stuck` verdict + [X402-47](https://vahdatfardin.atlassian.net/browse/X402-47) fixture-consumption infrastructure. Separately: [X402-40](https://vahdatfardin.atlassian.net/browse/X402-40) Node 22 `npx` ESM-resolver hang — Solana-dep drop branch **shelved** after 2-voice convergence (hypeprinter007's anchor-x402 Solana rail + TomSmart's x402-fetch transitive diagnostic); README install-section workaround shipped unconditionally. v0.3.1 shipped 2026-05-20 ([`x402trace@0.3.1`](https://www.npmjs.com/package/x402trace)).
- **v0.1 wedge:** Local HTTP proxy + timeout-reconciliation engine. Accepted 2026-05-12 in [ADR-001](./DECISIONS.md#adr-001-v01-wedge). Verified via three independent live Base Sepolia settlements ([tx `0x116ccf73…ba52`](https://sepolia.basescan.org/tx/0x116ccf73fa77eda19aea149606042f1e848e8afe2f719a0d2890dd2b2ff0ba52) is the X402-15 demo capture).
- **v0.2 scope:** `x402trace validate` (pre-flight) + `x402trace explain` (offline plain-English 402 diagnosis), sharing the `src/diagnose/` rule engine. Picked 2026-05-12 in [ADR-002](./DECISIONS.md#adr-002-v02-feature-pick--validate-primary--explain-paired). Shipped in v0.2.0..v0.2.3.
- **v0.3 scope:** `x402trace bazaar-check` (headline) + 5 facilitator-aware diagnose rules + `validate --diff` cross-facilitator + Base mainnet support + `versions` SDK skew (stretch, shipped). Picked 2026-05-14 in [ADR-003](./DECISIONS.md#adr-003-v03-feature-pick--bazaar-check-headline--5-facilitator-aware-diagnose-rules--validate---diff--base-mainnet-autonomous-execution-under-strict-6-stage-audit-gate). Execution autonomous per user direction; every ticket runs through the [Strict audit gate](#strict-audit-gate-autonomous-mode). v0.3.0 shipped 2026-05-17.
- **v0.3.1 hotfix scope:** [#66](https://github.com/fardinvahdat/x402trace/pull/66) + [#67](https://github.com/fardinvahdat/x402trace/pull/67) + `package.json` description fix. Both contributor PRs merged within 12h of opening — strongest "v0.3.0 found its audience" signal so far. Third independent positive: @TomSmart_ai ran `bazaar-check` against 19 production endpoints, 19/19 returned `implementation_issue` (production-scale validation of the verdict taxonomy).
- **v0.3.2 committed scope (7 items, in-flight):** D.1 manifest hygiene (shipped on main via PR #70 — needs D.5 variant-aware refactor before release) + D.2 propagation diff + D.3 indexer-state probe (introduces new top-level `upstream_stuck` verdict, rolls up to exit code 3) + D.4 `--endpoint <paid-url>` per-route probe + D.5 variant-aware `extensions.bazaar` (BodyDiscoveryExtension vs McpDiscoveryExtension; bug-pathway from #72) + JSON API stability commitment (snapshot tests + `src/bazaar/json-api.md` + versioning rule) + production-set fixture consumption (6-fixture pipeline: TomSmart 19-URL + cdp-mature + AsaiShota test-echo-cdp + evanatpizzarobot tensorfeed + 0xdespot hyperd + hypeprinter007 anchor-x402 multi-rail). ADR-004 (X402-41) lands first. **Held:** `facilitator-status` (Candidate A, 1 cluster), hosted demo (Candidate E, 1/4 signals), alt-challenge-surface (Candidate F, 1/n — 0xdespot's free-tier-upgrade observation from #2207, recorded as candidate; no implementation lean).
- **Repo:** https://github.com/fardinvahdat/x402trace
- **Jira:** https://vahdatfardin.atlassian.net/jira/software/projects/X402
- **Notion v0.2 plan:** https://www.notion.so/35c03c62b2638159a5e2d1ecaac5ff0b
- **Notion v0.3 plan:** https://www.notion.so/36003c62b26381fd9ae5c48758d53ccd
- **Notion v0.3.1+/v0.3.2 evidence page:** https://www.notion.so/36503c62b26381cfbd1ce4d95fabda82 (historical evidence accumulation; v0.3.1 + #2207 cluster + cdp-mature ETA)
- **Notion v0.3.2 committed plan:** https://www.notion.so/36603c62b26381b4b182ee5f6e07f002 (authoritative scope + ticket layout)

## Hard rules — non-negotiable

1. **Test everything, in every way appropriate to the change.** See [TESTING.md](./TESTING.md). No PR without tests. No exceptions. Documentation changes need link/format checks; code changes need unit + integration + (when user-facing) end-to-end tests; release changes need smoke tests. The rule is not "write some tests"; it is "the change is not done until I have proven, with tests, that it works and that nothing else broke."

2. **No committed mainnet RPC URLs.** v0.3 enables Base mainnet support (per [ADR-003](./DECISIONS.md#adr-003-v03-feature-pick--bazaar-check-headline--5-facilitator-aware-diagnose-rules--validate---diff--base-mainnet-autonomous-execution-under-strict-6-stage-audit-gate); the v0.1/v0.2 testnet-only rule is lifted), but **mainnet RPC URLs still must not be committed to the repo** — not in `.env`, not in `.env.example`, not in tests, not in fixtures, not in CI workflows. The user supplies their own mainnet RPC URL at runtime via env or `--rpc-url`. CI never uses mainnet.

3. **Never invent x402 spec details.** Read from `coinbase/x402`, `x402.org`, and the `x402` npm package. When uncertain, ask. Do not guess header formats, error codes, or facilitator behavior.

4. **Don't reproduce code from x402 SDKs.** Use them as dependencies. Cite their docs in comments where helpful.

5. **Branch off `main`.** All feature work happens in branches off `main`. PRs go back to `main`. `main` is protected — every commit lands via PR with required status checks. (Historical note: pre-v0.3.0 the convention was a `v1` integration branch; that ended when v0.3.x adopted main-trunk + per-ticket PRs per recent practice through #66–#99.)

6. **Keep secrets out of git.** Verify with `git check-ignore .env` before every commit.

7. **One thing per PR.** If a PR description has the word "also", split it.

8. **The published bundle defines the runtime dependency set.** Anything imported by code in `dist/` (whatever `tsconfig.build.json` emits) belongs in `dependencies`. Anything that exists only in `src/dogfood/`, `scripts/`, or `tests/` belongs in `devDependencies`. The `scripts/check-publish-surface.mjs` CI step enforces this; if it fails, the fix is to reclassify, not to suppress. See [v0.2.3 supply-chain post-mortem context](./CHANGELOG.md) for the original violation (`hono`/`x402-fetch`/`x402-hono` ship as `dependencies` in v0.2.2 despite zero imports from `dist/`, dragging the wallet-SDK transitive tree — and its CVE list — into every end-user install).

## Strict audit gate (autonomous mode)

Adopted 2026-05-14 in [ADR-003](./DECISIONS.md#adr-003-v03-feature-pick--bazaar-check-headline--5-facilitator-aware-diagnose-rules--validate---diff--base-mainnet-autonomous-execution-under-strict-6-stage-audit-gate) for the v0.3.0 cycle. **Active for every ticket while the project is in autonomous mode** (user not in the review loop). When the user is reviewing PRs in person again, the gate stays but the audit log in the PR body becomes optional rather than required.

**Why it exists:** the gate substitutes for the user's review judgment when the user is hands-off. Without it, autonomous mode degenerates into "ship the obvious diff" and edge cases ride along.

**Six stages. All must pass before the PR is self-merged.** Audit findings go into the PR body so the substitution is auditable post-hoc.

| Stage                    | Check                                                                                                                                                                              | Pass condition                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1. Pre-work              | Branch off latest `v1`; no concurrent-ticket conflict; dependencies (other tickets) merged or stubbed                                                                              | Clean `git status`, branch from origin/v1 HEAD                   |
| 2. Implementation        | All AC items from the Jira ticket coded                                                                                                                                            | Diff covers each AC checkbox; no drive-by changes                |
| 3. Correctness audit     | `pnpm typecheck` + `pnpm lint` + `pnpm test` + `pnpm build` + `pnpm check:publish-surface` all clean                                                                               | All five exit 0; no skipped tests except documented `X402_E2E=1` |
| 4. Edge-case enumeration | Enumerate ≥5 edge cases specific to the change; each tested OR documented as safe-to-skip with rationale                                                                           | Written into PR body                                             |
| 5. Re-audit (gap check)  | Re-read Notion plan + Jira AC; compare against actual diff. Check for missing AC items, drive-by changes, breaking changes to v0.2.x surface, interactions with other v0.3 tickets | Written into PR body as "no gaps" with diff anchor lines         |
| 6. Ship                  | PR to `v1` with audit log in body; CI green on both Node 20 + 22; self-merge; Jira transition to Done with audit summary                                                           | Workflow run green; PR merged; ticket Done                       |

**Edge cases always enumerated** (in addition to ticket-specific ones):

- Missing / malformed input (empty string, null, oversized payload)
- Network failures (timeout, DNS, TLS error)
- Concurrent operations (race conditions on the proxy event bus)
- Boundary values (zero, MAX_SAFE_INTEGER, negative)
- Non-ASCII / unicode in payloads

**Drive-by guard:** if there's a temptation to "clean up something not in the ticket," file a follow-up ticket and skip the change in this PR. Hard rule #7 ("one thing per PR") is enforced strictly.

**Hard blockers:** if a true blocker appears (CI infrastructure failure, npm registry down, branch protection misconfig), pause and explain in the PR thread — but default to keep going on every other class of problem.

## Project structure

```
x402trace/
├── CLAUDE.md           — this file
├── README.md           — public-facing intro
├── SPEC.md             — v0.1 implementation spec (filled in X402-8)
├── ARCHITECTURE.md     — components and data flow (filled in X402-9)
├── DECISIONS.md        — ADR log (append-only)
├── TESTING.md          — testing philosophy and conventions
├── CONTRIBUTING.md     — how to contribute
├── CHANGELOG.md        — Keep-a-Changelog format
├── dogfood-notes.md    — running journal of pain encountered while using x402
├── .env.example        — config template
├── package.json
├── tsconfig.json       — minimal strict ESM NodeNext (added pre-X402-10 to unblock the pipeline)
├── examples/           — runnable demos [shipped X402-15: e2e-timeout-reconciliation.sh]
├── .github/workflows/  — CI + release workflows [shipped X402-18]
└── src/
    ├── proxy/          — local HTTP proxy [shipped X402-10]
    ├── decoder/        — x402 message decoding + structured logger [shipped X402-11]
    ├── chain/          — Base RPC client (viem) [shipped X402-12, extended X402-21]
    ├── reconciliation/ — timeout reconciliation engine [shipped X402-13]
    ├── diagnose/       — diagnostic rule engine for validate + explain [shipped X402-21]
    └── cli/            — CLI entry point [shipped X402-14, +validate +explain X402-21]
```

There is also a non-published `src/dogfood/` (X402-3 test rig — Hono server + mock facilitator + http-adapter) used only by tests and `pnpm dogfood:*` scripts.

## Where to look first

| Question                         | File                                                                                                                                                                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What is x402?                    | [coinbase/x402 README](https://github.com/coinbase/x402), [x402.org](https://x402.org)                                                                                                                                                                                 |
| What is the wedge?               | [SPEC.md](./SPEC.md) — v0.1 implementation spec (Week-2 output, [X402-8](https://vahdatfardin.atlassian.net/browse/X402-8)). Read first before any Week-3+ ticket.                                                                                                     |
| Why this approach?               | [DECISIONS.md](./DECISIONS.md)                                                                                                                                                                                                                                         |
| What pain are we solving?        | [dogfood-notes.md](./dogfood-notes.md) — **start with § [Top painful moments](./dogfood-notes.md#top-painful-moments-synthesized---x402-6) and § [Wedge candidates](./dogfood-notes.md#wedge-candidates) (the X402-6 synthesis: 9 ranked pains + 5 candidate wedges)** |
| How do components fit together?  | [ARCHITECTURE.md](./ARCHITECTURE.md) — 5 components (Proxy / Decoder / Chain / Reconciliation / CLI), the TypeScript interfaces at the boundaries, the JSONL record format. Read before any build ticket in X402-10..14.                                               |
| What's in the JSONL log on disk? | [src/decoder/schema.md](./src/decoder/schema.md) — authoritative shape of every `event:` discriminant the decoder emits. The file IS the API; breaking the shape requires a new ADR.                                                                                   |
| How do I test?                   | [TESTING.md](./TESTING.md)                                                                                                                                                                                                                                             |

## Branching strategy

- `main` — active development trunk. Release tags live here. Protected: every commit lands via PR with required status checks (typecheck + lint + test on Node 20/22, build, publish-surface).
- Per task: `<type>/X402-<n>-<slug>` (e.g. `feat/X402-53-host-pollution`). PRs target `main`.
- `staging` and `v1` are historical branches from the v0.1/v0.2 cycle; not used in v0.3.x.

**Branch type prefixes:** `feat/`, `fix/`, `docs/`, `test/`, `ci/`, `chore/`, `release/`.

## Tech stack (decided)

- **Language:** TypeScript (strict mode, ESM)
- **Runtime:** Node >= 20
- **Chain client:** viem (not ethers)
- **Test runner:** vitest (not jest)
- **Package manager:** pnpm
- **Lint/format:** ESLint + Prettier

## What x402trace is NOT

- Not a hosted SaaS (v0.1)
- Not multi-chain (Base only for v0.1)
- Not a wallet
- Not a facilitator
- Not a competitor to xpay, x402scan, x402lint — see SPEC.md "differentiation" once written

## Working notes for Claude Code

- When starting a session: read CLAUDE.md, [SPEC.md](./SPEC.md), and the Jira ticket linked in the branch name.
- When the work touches feature design, wedge scope, or "should we build X": read [dogfood-notes.md § Top painful moments](./dogfood-notes.md#top-painful-moments-synthesized---x402-6) first. That table is the project's grounded pain inventory; every proposed feature should map back to at least one ranked pain there.
- When the work touches the JSONL on-disk format (anything that reads or writes events): read [src/decoder/schema.md](./src/decoder/schema.md) first. Don't add a new `event:` discriminant without an ADR; downstream consumers (reconciliation, future `x402trace reconcile --log`, v0.2 features) all depend on it.
- When stuck on x402 protocol details: read the actual `x402` npm package source. Don't guess.
- When suggesting a refactor: propose it in a comment first, get user confirmation, then change code.
- When tests are hard to write for a piece of code: that's a design signal. Refactor for testability first.
- When asked to "just ship it" without tests: refuse politely and explain the hard rule.

## References

- coinbase/x402: https://github.com/coinbase/x402
- x402.org: https://x402.org
- Base Sepolia faucet: https://faucet.circle.com
- viem docs: https://viem.sh
- vitest docs: https://vitest.dev
