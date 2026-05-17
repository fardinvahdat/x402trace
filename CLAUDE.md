# CLAUDE.md — Operating manual for x402trace

This file is read by Claude Code at the start of every session. Keep it current; it is the project's living memory.

## Project mission

**x402trace** is a local CLI for debugging [x402](https://x402.org) payment flows on Base. Its first job is detecting **timeout reconciliation failures** — cases where the facilitator times out but the on-chain transaction settled anyway, leaving the wallet debited and the user with no recovery path.

Canonical reference: [coinbase/x402 Issue #1062](https://github.com/coinbase/x402/issues/1062).

## Status

- **Phase:** v0.2.3 shipped 2026-05-13 ([`x402trace@0.2.3`](https://www.npmjs.com/package/x402trace) — supply-chain hardening cut). Now in **v0.3.0 scope, autonomous-mode execution under strict audit gate** per [ADR-003](./DECISIONS.md#adr-003-v03-feature-pick--bazaar-check-headline--5-facilitator-aware-diagnose-rules--validate---diff--base-mainnet-autonomous-execution-under-strict-6-stage-audit-gate).
- **v0.1 wedge:** Local HTTP proxy + timeout-reconciliation engine. Accepted 2026-05-12 in [ADR-001](./DECISIONS.md#adr-001-v01-wedge). Verified via three independent live Base Sepolia settlements ([tx `0x116ccf73…ba52`](https://sepolia.basescan.org/tx/0x116ccf73fa77eda19aea149606042f1e848e8afe2f719a0d2890dd2b2ff0ba52) is the X402-15 demo capture).
- **v0.2 scope:** `x402trace validate` (pre-flight) + `x402trace explain` (offline plain-English 402 diagnosis), sharing the `src/diagnose/` rule engine. Picked 2026-05-12 in [ADR-002](./DECISIONS.md#adr-002-v02-feature-pick--validate-primary--explain-paired). Shipped in v0.2.0..v0.2.3.
- **v0.3 scope:** `x402trace bazaar-check` (headline) + 5 facilitator-aware diagnose rules + `validate --diff` cross-facilitator + Base mainnet support. Stretch: `versions` SDK skew, SLA-breach observation. Picked 2026-05-14 in [ADR-003](./DECISIONS.md#adr-003-v03-feature-pick--bazaar-check-headline--5-facilitator-aware-diagnose-rules--validate---diff--base-mainnet-autonomous-execution-under-strict-6-stage-audit-gate). Execution autonomous per user direction; every ticket runs through the [Strict audit gate](#strict-audit-gate-autonomous-mode).
- **Timeline:** ~4 weeks to v0.3.0. Implementation in [X402-32](https://vahdatfardin.atlassian.net/browse/X402-32) / [X402-33](https://vahdatfardin.atlassian.net/browse/X402-33) / [X402-34](https://vahdatfardin.atlassian.net/browse/X402-34) / [X402-35](https://vahdatfardin.atlassian.net/browse/X402-35), stretch in [X402-36](https://vahdatfardin.atlassian.net/browse/X402-36) / [X402-37](https://vahdatfardin.atlassian.net/browse/X402-37), release in [X402-38](https://vahdatfardin.atlassian.net/browse/X402-38).
- **Repo:** https://github.com/fardinvahdat/x402trace
- **Jira:** https://vahdatfardin.atlassian.net/jira/software/projects/X402
- **Notion v0.2 plan:** https://www.notion.so/35c03c62b2638159a5e2d1ecaac5ff0b
- **Notion v0.3 plan:** https://www.notion.so/36003c62b26381fd9ae5c48758d53ccd

## Hard rules — non-negotiable

1. **Test everything, in every way appropriate to the change.** See [TESTING.md](./TESTING.md). No PR without tests. No exceptions. Documentation changes need link/format checks; code changes need unit + integration + (when user-facing) end-to-end tests; release changes need smoke tests. The rule is not "write some tests"; it is "the change is not done until I have proven, with tests, that it works and that nothing else broke."

2. **No committed mainnet RPC URLs.** v0.3 enables Base mainnet support (per [ADR-003](./DECISIONS.md#adr-003-v03-feature-pick--bazaar-check-headline--5-facilitator-aware-diagnose-rules--validate---diff--base-mainnet-autonomous-execution-under-strict-6-stage-audit-gate); the v0.1/v0.2 testnet-only rule is lifted), but **mainnet RPC URLs still must not be committed to the repo** — not in `.env`, not in `.env.example`, not in tests, not in fixtures, not in CI workflows. The user supplies their own mainnet RPC URL at runtime via env or `--rpc-url`. CI never uses mainnet.

3. **Never invent x402 spec details.** Read from `coinbase/x402`, `x402.org`, and the `x402` npm package. When uncertain, ask. Do not guess header formats, error codes, or facilitator behavior.

4. **Don't reproduce code from x402 SDKs.** Use them as dependencies. Cite their docs in comments where helpful.

5. **Branch off `v1`.** All feature work happens in branches off `v1`. PRs go back to `v1`. `staging` and `main` are integration/release branches — never push directly.

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

- `main` — protected. Release tags live here. **Never push directly.**
- `staging` — protected. `v1` merges into `staging` for integration testing, then `staging` into `main`.
- `v1` — active integration branch for v0.1. All feature branches PR back here.
- Per task: `<type>/X402-<n>-<slug>` (e.g. `feat/X402-13-reconciliation`).

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
