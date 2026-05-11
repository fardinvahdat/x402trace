# CLAUDE.md — Operating manual for x402trace

This file is read by Claude Code at the start of every session. Keep it current; it is the project's living memory.

## Project mission

**x402trace** is a local CLI for debugging [x402](https://x402.org) payment flows on Base. Its first job is detecting **timeout reconciliation failures** — cases where the facilitator times out but the on-chain transaction settled anyway, leaving the wallet debited and the user with no recovery path.

Canonical reference: [coinbase/x402 Issue #1062](https://github.com/coinbase/x402/issues/1062).

## Status

- **Phase:** Pre-v0.1 build
- **Wedge:** Timeout reconciliation (tentative; confirmed in Week 2 via ADR-001)
- **Timeline:** 6 weeks to v0.1
- **Repo:** https://github.com/fardinvahdat/x402trace
- **Jira:** https://vahdatfardin.atlassian.net/jira/software/projects/X402
- **Notion plan:** https://www.notion.so/35c03c62b2638159a5e2d1ecaac5ff0b

## Hard rules — non-negotiable

1. **Test everything, in every way appropriate to the change.** See [TESTING.md](./TESTING.md). No PR without tests. No exceptions. Documentation changes need link/format checks; code changes need unit + integration + (when user-facing) end-to-end tests; release changes need smoke tests. The rule is not "write some tests"; it is "the change is not done until I have proven, with tests, that it works and that nothing else broke."

2. **Testnet only until v0.1 ships.** All dev work runs on Base Sepolia. Mainnet RPC URLs are forbidden in any committed file (including `.env.example`).

3. **Never invent x402 spec details.** Read from `coinbase/x402`, `x402.org`, and the `x402` npm package. When uncertain, ask. Do not guess header formats, error codes, or facilitator behavior.

4. **Don't reproduce code from x402 SDKs.** Use them as dependencies. Cite their docs in comments where helpful.

5. **Branch off `v1`.** All feature work happens in branches off `v1`. PRs go back to `v1`. `staging` and `main` are integration/release branches — never push directly.

6. **Keep secrets out of git.** Verify with `git check-ignore .env` before every commit.

7. **One thing per PR.** If a PR description has the word "also", split it.

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
├── tsconfig.json       — created in X402-10
└── src/                — appears in Week 3 (X402-10+)
    ├── proxy/          — local HTTP proxy
    ├── decoder/        — x402 message decoding + logging
    ├── chain/          — Base RPC client
    ├── reconciliation/ — timeout reconciliation engine
    └── cli/            — CLI entry point
```

## Where to look first

| Question | File |
| --- | --- |
| What is x402? | [coinbase/x402 README](https://github.com/coinbase/x402), [x402.org](https://x402.org) |
| What is the wedge? | [SPEC.md](./SPEC.md) (after Week 2) |
| Why this approach? | [DECISIONS.md](./DECISIONS.md) |
| What pain are we solving? | [dogfood-notes.md](./dogfood-notes.md) — **start with § [Top painful moments](./dogfood-notes.md#top-painful-moments-synthesized---x402-6) and § [Wedge candidates](./dogfood-notes.md#wedge-candidates) (the X402-6 synthesis: 9 ranked pains + 5 candidate wedges)** |
| How do components fit together? | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| How do I test? | [TESTING.md](./TESTING.md) |

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

- When starting a session: read CLAUDE.md, SPEC.md (once written), and the Jira ticket linked in the branch name.
- When the work touches feature design, wedge scope, or "should we build X": read [dogfood-notes.md § Top painful moments](./dogfood-notes.md#top-painful-moments-synthesized---x402-6) first. That table is the project's grounded pain inventory; every proposed feature should map back to at least one ranked pain there.
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
