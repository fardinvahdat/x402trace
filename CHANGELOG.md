# Changelog

All notable changes to **x402trace** will be documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- Initial project scaffold (X402-2)
- `CLAUDE.md` operating manual for Claude Code sessions
- `TESTING.md` defining test requirements per change type
- `SPEC.md`, `ARCHITECTURE.md`, `DECISIONS.md` skeletons
- `CONTRIBUTING.md`, `dogfood-notes.md` skeletons
- `.env.example` configuration template
- `.github/PULL_REQUEST_TEMPLATE.md` enforcing test checklist
- Apache 2.0 license
- Dogfood rig on Base Sepolia (X402-3): Hono + `x402-hono@1.2.0` server (`src/dogfood/app.ts`, `api/[...all].ts` for Vercel, `scripts/dev-server.ts` for local), paying client via `x402-fetch@1.2.0` (`scripts/dogfood-client.ts`), env validation with mainnet-RPC guard (`src/dogfood/config.ts`), and 20 unit tests covering config validation and 402 challenge generation. **Verified end-to-end against the real `x402.org/facilitator`** on Base Sepolia — paid GET returned 200 with on-chain settlement tx [`0x8b53a04d…b3428`](https://sepolia.basescan.org/tx/0x8b53a04d71cd7dcc35fdf3682ae173758a76213db4ec1abae3e846b8c12b3428).
- Public Vercel production deploy (X402-3) on the `v1` branch alias at [`x402trace-dogfood-git-v1-fardinvahdats-projects.vercel.app`](https://x402trace-dogfood-git-v1-fardinvahdats-projects.vercel.app) serving `/` (static landing) and `/api/weather` (x402-gated). Second on-chain settlement against the real `x402.org/facilitator` from this production endpoint: tx [`0xc5758bf2…6cbf`](https://sepolia.basescan.org/tx/0xc5758bf2a0f8668a5613aae125a7ab529ef90ce96760020a1ff73309788c6cbf).
- Five-failure-mode reproduction harness for X402-4 (`scripts/failure-modes.ts`, `pnpm dogfood:failure-modes <n>`). Captures verbatim server/client/facilitator error strings for: wrong chain ID, expired `validBefore`, insufficient USDC, malformed signature, facilitator unavailable. Full transcripts + diagnoses in `dogfood-notes.md` § Failure modes.
- Week-1 pain synthesis (X402-6) in `dogfood-notes.md` § Top painful moments: 9 ranked pains + 5 wedge candidates (A reconciliation, B inspect+doctor, C bazaar-check, D cross-facilitator, E proxy substrate) — pulls from X402-3 dogfood capture, X402-4 failure modes, X402-5 GitHub catalogue, and the Notion Validation evidence page. CLAUDE.md updated to point future sessions at the table for feature-scope work.
- **v0.1 wedge accepted (X402-7) — ADR-001 in `DECISIONS.md`: local HTTP proxy substrate + timeout-reconciliation engine on top.** Scope tightened for the 5-week timeline: Base Sepolia only, single facilitator profile (`x402.org/facilitator`), `exact` EVM scheme only, detect-and-notify (no auto-refund in v0.1). CLAUDE.md status updated from "tentative" to "accepted." Bazaar diagnostics, cross-facilitator drift, inspect/doctor/versions deferred to v0.2+.
- Local mock x402 facilitator (X402-3) at `src/dogfood/mock-facilitator.ts` implementing v1 `POST /verify` and `POST /settle` with canned-success responses. Unblocks integration testing without on-chain USDC and provides the test harness `TESTING.md` calls for. `scripts/mock-facilitator.ts` is the standalone entry; `tests/integration/dogfood-paid-flow.test.ts` asserts the full 402 → signed retry → 200 + `X-PAYMENT-RESPONSE` flow against it.
- Shared `src/dogfood/http-adapter.ts` for mounting a Hono app on a Node `http` server (used by `dev-server.ts`, `mock-facilitator.ts`, and the integration test). Avoids a separate `@hono/node-server` dep.
- Minimal `tsconfig.json` (strict ESM NodeNext), `vitest.config.ts`, `eslint.config.js` (flat), and `.prettierrc.json` scoped to what X402-3 needed. X402-10 will tighten and broaden these.

### Changed

—

### Deprecated

—

### Removed

—

### Fixed

—

### Security

—

---

[Unreleased]: https://github.com/fardinvahdat/x402trace/compare/main...HEAD
