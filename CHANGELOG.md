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
- v0.1 implementation spec (X402-8) filled in at `SPEC.md`: problem, solution, user flow (`x402trace proxy --upstream <url> --reconcile` + sample `RECONCILED ⚠ settled-but-server-thinks-not` output), v0.1 scope/v0.2 stretch lists, 5 success-criteria checkboxes, explicit out-of-scope non-goals, and per-competitor differentiation against xpay / x402scan / x402lint / x402-watch / zauth / PaySentry. Linked from CLAUDE.md.
- v0.1 architecture (X402-9) finalized in `ARCHITECTURE.md`: 5-component decomposition (Proxy `src/proxy/`, Decoder `src/decoder/`, Chain `src/chain/`, Reconciliation `src/reconciliation/`, CLI `src/cli/`) with one-example data flow traced through every component for happy / rejected / timeout outcomes; TypeScript interface stubs ready to become source code (PaymentRequirements, PaymentPayload, FacilitatorResponse, PaymentExchange, ExchangeOutcome, ChainTransfer, ReconciliationResult); canonical JSONL record format (the file is the API); full configuration precedence table; v0.2 extension points named per feature so no v0.1 component is rewritten for v0.2.
- **Proxy core (X402-10)** in `src/proxy/`: forward HTTP proxy that captures every exchange to a JSONL log + in-process event bus. Five modules — `proxy.ts` (server + forwarding via fetch), `types.ts` (`ProxyEvent` / `CapturedRequest` / `CapturedResponse` / `ExchangeOutcome` discriminated union + `isLikelyX402Exchange` heuristic), `event-bus.ts` (subscribe-with-queue-and-drop-counter pub-sub), `jsonl-sink.ts` (append-only writer), `id.ts` (per-exchange UUIDs). Hop-by-hop headers stripped per RFC; non-UTF8 bodies base64-encoded; upstream timeout returns 502 + `proxy.error` event. Deliberately dumb — no x402 parsing here (that's X402-11). 18 new unit tests + a 4-test integration that pipes the dogfood client through the proxy at the X402-3 dogfood rig (mock-facilitator-backed) and asserts both the 402 and the paid 200 are captured to JSONL with the right discriminants. `pnpm proxy --upstream <url>` runs it; full `npx x402trace proxy` plumbing arrives in X402-14.
- **x402 message decoder (X402-11)** in `src/decoder/`: pure-function parsers that turn raw `ProxyEvent`s into typed `DecodedEvent`s. Six modules — `types.ts` (`PaymentRequirements`, `PaymentAuthorization`, `PaymentPayload`, `FacilitatorResponse`, `DecodedEvent` discriminated union), `parse.ts` (`parseChallengeBody`, `parsePaymentHeader`, `parseSettlementHeader`, version detection — uses `x402/schemes`'s `exact.evm.decodePayment` for the v1 fast path, hand-rolled fallback for v2), `redact.ts` (signature redaction by default, `--log-secrets` opt-in), `format.ts` (`formatHuman` and `formatJson`), `decoder.ts` (`createDecoder()` stream consumer), `index.ts`. Includes [`src/decoder/schema.md`](src/decoder/schema.md) documenting the JSONL contract. Handles both v1 (`X-PAYMENT` / `X-PAYMENT-RESPONSE`) and v2 (`PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`) header surfaces. 22 new unit tests covering v1 + v2 parsers, redaction, formatting + a 4-test integration that asserts the proxy→decoder→PaymentExchange pipeline produces the right structured events from a paid flow. Stdout sample of the readable output is captured in [`dogfood-notes.md` § "Decoder readable-output sample"](dogfood-notes.md#decoder-readable-output-sample-x402-11-2026-05-12) per acceptance criterion; `pnpm decoder:demo` reproduces it.
- **Base RPC client (X402-12)** in `src/chain/`: thin viem wrapper over Base Sepolia. Five modules — `types.ts` (`ChainTransfer` + `VerifyTransferResult` 7-variant discriminated union: `confirmed` / `pending` / `reverted` / `not_found` / `wrong_recipient` / `wrong_amount` / `wrong_token`), `abi.ts` (Base Sepolia USDC address `0x036CbD…CF7e` + Transfer + EIP-3009 AuthorizationUsed event ABIs), `retry.ts` (exponential backoff, 3 attempts default per ARCHITECTURE.md), `client.ts` (`createChainClient` with `verifyTransfer`, `getTransferByTxHash`, `subscribeUsdcTransfers` AsyncIterable, `getBlockNumber`), `index.ts`. Read-only — never holds private keys, never broadcasts. `subscribeUsdcTransfers` enriches each `Transfer` event with the matching `AuthorizationUsed.nonce` from the same tx so the reconciliation engine can match by EIP-3009 nonce. 16 unit tests with mocked transport covering all 7 verify variants + the retry helper + 4 e2e tests against live Base Sepolia (gated by `X402_E2E=1`; verified against the two real X402-3 settlement txs `0x8b53a04d…b3428` and `0xc5758bf2…6cbf`).
- **CLI binary (X402-14)** in `src/cli/` + `src/cli.ts`: the user-facing surface for v0.1, composing the four substrates (Proxy / Decoder / Chain / Reconciliation) into a single `x402trace` command. Two subcommands — `x402trace proxy --upstream <url> [--port 8402] [--log human|json] [--log-file <path>] [--log-secrets] [--reconcile] [--rpc-url <url>] [--watch-timeout-ms <n>]` runs the live pipeline; `x402trace inspect <jsonl-log-file> [--log human|json] [--watch-timeout-ms <n>]` replays a captured log and re-runs reconciliation offline. Built on `commander@14`. Modules — `index.ts` (commander dispatch + `runCli` testable entry), `proxy-command.ts` (live pipeline wiring; opens a second `JsonlSink` against the same log path for `chain.transfer` and `reconcile.result` records — **closes the X402-13 deferred acceptance bullet** "All reconciliation events written to a local JSONL log file"), `inspect-command.ts` (offline replay), `replay.ts` (JSONL reader driving a virtual-clock engine via the new `engine.tick()` sweep method), `format-result.ts` (human + JSON renderers for `ReconciliationResult` — the canonical `RECONCILED ⚠ settled-but-server-thinks-not` headline per [SPEC.md § 3](./SPEC.md#3-user-flow)), `color.ts` (TTY + `NO_COLOR`-aware ANSI helpers; no `chalk` dep), `exit-codes.ts` (0 success / 1 usage / 2 runtime per the X402-14 ticket). 28 new unit tests + 1 smoke test that drives the full proxy + decoder + JSONL pipeline against the dogfood rig and replays the captured log through `inspect`. Pipeline: 149 tests / 4 e2e skipped, typecheck + lint clean. `scripts/proxy.ts` is now a thin shim that defers to `runCli`; `pnpm proxy` and `pnpm x402trace` both work, and `npx x402trace` will work once published.
- **Timeout reconciliation engine (X402-13)** in `src/reconciliation/`: the headline feature of the v0.1 wedge. Four modules — `types.ts` (`PendingExchange` + `ReconciliationResult` 4-variant discriminated union: `settled_on_chain` / `not_settled` / `value_mismatch` / `recipient_mismatch`), `match.ts` (pure `matchPendingAgainstTransfer` checking `(payer, payee, value, nonce)` exact-equality; case-insensitive on addresses + nonce), `engine.ts` (`createReconciliationEngine({watchTimeoutMs?, sweepIntervalMs?, now?}) → Engine` with three ingest methods for proxy / decoder / chain streams, in-memory pending-set with two-half-join semantics, periodic sweep for `not_settled` after `watchTimeoutMs` (default 60_000), injectable clock for tests), `index.ts`. 17 unit tests covering the match function + engine lifecycle (rejected outcomes flag, paid outcomes don't, settled_on_chain emit, not_settled timeout, value/recipient mismatch, arrival-order independence) + 2-test integration that **reproduces the canonical [#1062](https://github.com/coinbase/x402/issues/1062) scenario** end-to-end: mock facilitator rejects → engine emits `settled_on_chain` when matching ChainTransfer arrives. Pipeline: 120 tests / 4 e2e skipped, no new deps.
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
