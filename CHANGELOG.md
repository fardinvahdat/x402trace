# Changelog

All notable changes to **x402trace** will be documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

—

## [0.3.1] — 2026-05-20

Hotfix release covering two `bazaar-check` bugs surfaced by external contributors within 72 hours of v0.3.0 ship, plus an npm-metadata fix from the v0.3.0 post-publish audit. No breaking changes — strictly additive.

### Fixed

- **`parseChallengeBody` false-fails on canonical x402 v2 challenge bodies** ([#65](https://github.com/fardinvahdat/x402trace/issues/65) → [#66](https://github.com/fardinvahdat/x402trace/pull/66), thanks @hypeprinter007-stack 🙏 — first external contributor). v0.3.0's `src/decoder/parse.ts` detected `x402Version` correctly but enforced v1 field names regardless, so v2-compliant bodies using the renamed `amount` field (instead of v1's `maxAmountRequired`) and lacking the v1 per-accept `resource` field failed with `challenge accepts[0].maxAmountRequired missing or wrong type`. v2 bodies are now normalized at parse time (`amount → maxAmountRequired` when only `amount` is present) and the per-accept `resource` requirement is dropped under v2 (resource lives top-level in v2). Error messages under v2 include the hint `(v2 field name: "amount")` so operators don't have to spec-dive. Surfaced against the real v2 service `api.anchor-x402.com`; e2e-verified to flip `bazaar-check` exit code from `2` (false-fail) to `0` (looks_correct).
- **`bazaar-check` hung indefinitely on stalled HTTP probes** ([#67](https://github.com/fardinvahdat/x402trace/pull/67), thanks @peterxing 🙏). When a checked endpoint accepted the connection but never resolved — or sent headers but then stalled the body — the CLI hung until killed manually, breaking CI / automation use. Now wrapped with a **10s default per-probe timeout** via `AbortController`; configurable with `--timeout-ms` for CI / smoke runs / known-flaky endpoints. Body-read path keeps the timer active across `arrayBuffer` / `blob` / `formData` / `json` / `text` so headers-arrived-but-body-stalls is caught too. Upper bound validated against Node's `setTimeout` cap (`2_147_483_647`).

### Changed

- **`package.json` `description`** now reflects the v0.3 headline subcommands (was v0.2-era: `"x402 payment debugger for Base. Detects reconciliation failures, pre-flights wallets, explains 402s."`). Closes the audit gap discovered post-v0.3.0 publish where the npm-displayed package description didn't mention `bazaar-check`, `validate --diff`, or mainnet support. New audit-gate checklist item carried forward to v0.3.2+: _"package.json description and README headline list both reflect this version's user-facing features."_
- **`src/cli/index.ts` `VERSION` constant** bumped 0.3.0 → 0.3.1.

### Removed

- **Stale `--rpc-url` example for `bazaar-check`** in the README. `bazaar-check` is HTTP-only and doesn't need an RPC URL (it uses the CDP discovery API for the indexing query); the example was misleading.

### Notes

- **Adoption signal.** Two distinct external contributors in 72 hours after v0.3.0 ship (@hypeprinter007-stack and @peterxing); both PRs merged within 12 hours of opening. Strongest "v0.3.0 found its audience" signal so far. Third independent positive signal in the same window: @TomSmart_ai (mapper operator) ran `bazaar-check` against 19 endpoints from his production catalog, 19/19 returned `implementation_issue` — first production-scale validation of the verdict taxonomy.
- **Pitch-language update.** TomSmart_ai's framing — _"catches the listing-readiness gap"_ vs _"speaks x402 at all"_ (his strict-v2 sweep showed 88% protocol-valid on the same catalog) — is sharper than the prior README copy. Forward to v0.3.2+ surfaces.
- **No breaking changes.** v0.3.0 → v0.3.1 is backward-compatible. v1 challenge bodies parse unchanged. Callers that don't pass `--timeout-ms` get the new 10s default; callers that need the old "wait forever" behaviour can pass `--timeout-ms 2147483647` (Node's timer max, the documented upper bound).
- **Test count:** 410 in v0.3.0 → 415 in v0.3.1 (+2 from #66 v2 parse coverage, +3 from #67 timeout coverage). All existing tests pass unchanged.

## [0.3.0] — 2026-05-17

The v0.3 release. Operator-side debugging cut: x402trace can now answer the question Discord operators are asking each other in real time — _"is my Bazaar / agentic.market integration correct, or is the bug upstream of me?"_ — in a 30-second command-line check. Same shipped binary contract as v0.2.x (no breaking changes to existing subcommands); two new subcommands; five new facilitator-aware diagnose rules; Base mainnet support behind an opt-in `--chain` flag; cross-facilitator drift detection on `validate`. Strict 6-stage audit gate ran on every ticket (X402-31..36).

### Added

- **`x402trace bazaar-check <service-url>` (X402-32, headline).** Pre-ship Bazaar / agentic.market implementation validator. Four read-only checks compose into a single bottom-line verdict: `/.well-known/x402` manifest, 402 challenge structure (`extensions.bazaar.{name, description}`), self-payment guard (`--payer-hint`), and CDP indexing query (`/v2/x402/discovery/resources`). Exit codes: `0` looks_correct, `2` implementation_issue, `3` upstream_issue (the [#2207](https://github.com/x402-foundation/x402/issues/2207) Bazaar-indexing pattern; named explicitly in the verdict prose). Maps the dominant Discord pain — ≥10 named voices on the #2207 cluster.
- **`x402trace validate --diff <facilitators>` (X402-35).** Cross-facilitator drift detection. Comma-separated aliases (`cdp`, `xpay`, `payai`, `x402.org`) OR full URLs. Runs the synthesised payload through each facilitator's `/verify` endpoint in parallel via `Promise.all`, captures per-facilitator HTTP into a `FacilitatorInteraction`, and runs the X402-33 facilitator-aware rules per-facilitator. Exit codes: `0` any_accepts, `2` all_reject, `3` all_timeout. Closes TerraDeed's CDP → xpay manual workaround (Discord transcript) and [#2184](https://github.com/x402-foundation/x402/issues/2184) (PayAI + Python SDK 2.9.0).
- **`x402trace versions <service-url>` (X402-36, stretch).** SDK skew audit. Walks up from cwd for `package.json` and extracts `@x402/*` / `x402-*` / `x402` versions; fetches the service URL's 402 for `x402Version` + `Server` header hints; matches both against a bundled known-skew dataset (`@x402/fetch@2.10.0` extension echo bug, `@x402/hono` `syncFacilitatorOnStart` default, pre-v2 Python SDK bazaar emission). Exit `0` no skew / `2` skew detected. Closes Myceliaman14 + Poteshniy's Discord chases.
- **Five new facilitator-aware diagnose rules (X402-33).** `cdpMinAmountRule`, `selfPaymentRule`, `facilitatorThrottlingRule`, `extensionResponsesMissingRule`, `gasEstimationFailureRule`. Each backed by named Discord/GitHub voices per [ADR-003](./DECISIONS.md). New `FacilitatorInteraction` type + `DiagnosticContext.facilitator` + `DiagnosticContext.expectsBazaarExtensions` fields. Rules skip cleanly when their context fields are absent.
- **Base mainnet support (X402-34).** New `--chain <base-sepolia|base>` flag on `proxy`, `inspect`, `validate`, `bazaar-check`, `versions`. Default stays `base-sepolia` (no surprise change). `--chain base` switches to Base mainnet (chain ID 8453) with the canonical mainnet USDC address (`0x833589fCD…`). Mainnet RPC URL must be supplied via `--rpc-url` or `BASE_RPC_URL` env; **no default mainnet endpoint is shipped** (CLAUDE.md hard rule #2). New `BASE_CHAIN_ID` env (accepts `"base"`/`"base-sepolia"` OR numeric `"8453"`/`"84532"`, case-insensitive). Mainnet startup banner emits to stdout (human) or stderr (JSON). New `ChainKey` exported type, `BASE_USDC` constant, `usdcAddressFor()` helper.
- **`EXIT_UPSTREAM = 3` exit code constant** in `src/cli/exit-codes.ts`. Distinguishes "upstream issue detected" (bazaar-check, validate --diff all-timeout) from "implementation issue" (`EXIT_RUNTIME = 2`) and "usage error" (`EXIT_USAGE = 1`).
- **ADR-003 in DECISIONS.md (X402-31).** v0.3 feature pick + autonomous-mode strict 6-stage audit gate codification. The gate substitutes for user review during autonomous execution; every PR in v0.3 ran through Pre-work → Implementation → Correctness audit → Edge-case enumeration → Re-audit → Ship.
- **CLAUDE.md hard rule #8 + "Strict audit gate" section.** Codifies the gate so future sessions follow it.
- **Cross-platform evidence base.** Plan and ADR-003 cite Discord transcript (10+ named voices on Bazaar indexing failures), GitHub issues ([#2207](https://github.com/x402-foundation/x402/issues/2207) cluster, [#1065](https://github.com/x402-foundation/x402/issues/1065), [#2294](https://github.com/x402-foundation/x402/issues/2294)), Dev.to article, and agentic.market directory.

### Changed

- **CLAUDE.md hard rule #2** updated from "Testnet only until v0.1 ships" to "No committed mainnet RPC URLs" (v0.3 enables mainnet code; CI never uses mainnet).
- **`src/cli/index.ts` `VERSION` constant** bumped 0.2.3 → 0.3.0 (kept in sync with `package.json`).

### Deferred to v0.3.1+

- **Paid-pass mode (`--with-wallet`) in `bazaar-check`** — requires signing infrastructure (changes ADR-001 read-only contract) or pre-signed payload pipeline. Static-analysis-only bazaar-check ships now; real-settlement EXTENSION-RESPONSES surfacing is detectable via X402-33's `extensionResponsesMissingRule` for callers that drive their own facilitator HTTP.
- **SLA-breach observation event (X402-37)** — single Discord voice + schema-change risk failed the strict-bar; deferred until a 2nd named operator surfaces independently. Hikari is shipping Recourse as the enforcement product.
- **ERC-6492 Smart Wallet support, reconciliation webhook/auto-retry, `extensions.diagnostic` decoder (gated on PR [#1875](https://github.com/x402-foundation/x402/pull/1875)), `tokenNameMismatchRule`, `repeatedNonceRule`, daemon mode, audit export, multi-chain (non-Base), hosted SaaS** — all listed in [ADR-003](./DECISIONS.md) with documented deferral reasons.

### Fixed (X402-38 pre-publish audit, 2026-05-17)

- **`validate --diff`: AbortController signal was never passed to fetch** — the timeout fired `controller.abort()` but the fetch call didn't receive the signal, so real-world timeouts would not actually cancel the request. Tests passed because the mock fetcher threw `AbortError` directly. **Fix:** `DiffFetcher` type extended with `signal?: AbortSignal`; signal now plumbed through. Two new regression tests assert the signal is received by the fetcher and reports `aborted=true` after the timeout window.
- **Pre-existing flake at `tests/integration/demo-timeout-reconciliation.test.ts:114`** (50ms fixed sleep racing the engine event bus under parallel-test load). Hit CI twice in this session; would have intermittently broken the publish workflow's `prepublishOnly` step. **Fix:** replaced fixed sleep with a `pollFor` helper that retries up to 2s in 25ms steps. 5/5 consecutive runs pass post-fix.

### Notes

- **278 → 410 tests** (+132 new across X402-31..36 + audit). The pre-existing flake noted above is now deterministic.
- **Tarball size:** 74 files / 222 KB unpacked at v0.2.3 → **96 files / ~337 KB unpacked at v0.3.0**. Well under the 400 KB CI guard cap.
- **Runtime `dependencies` count unchanged** from v0.2.3 (4: `commander`, `dotenv`, `viem`, `x402`). No supply-chain expansion.
- **Audit findings documented but NOT fixed in v0.3.0** (all low severity, none block release):
  1. `cdpMinAmountRule` applies the same minimum across chains; the $0.001 was Discord-confirmed for Sepolia only. Mainnet minimum may differ. Rule fails-soft (suggests a higher amount); documented inline in [src/diagnose/rules.ts](./src/diagnose/rules.ts).
  2. `validate --diff` silently overrides `--strict`. Documented in [src/cli/validate-command.ts](./src/cli/validate-command.ts).
  3. `parseFacilitatorList` allows duplicate aliases (e.g. `--diff cdp,cdp`). Harmless but wasteful; documented.
  4. `extractX402Versions` (the `versions` subcommand) accepts non-semver values (`workspace:*`, `github:foo/bar`). `match: "any"` known-skew entries can fire false-positives for monorepo users. Edge case; promote to a fix when a real user reports it.

## [0.2.3] — 2026-05-13

Supply-chain hardening patch. **No functional changes from 0.2.2** — same CLI behaviour, same diagnostic rules, same chain client, same shipped binary (`dist/`). The bump exists to publish a cleaner install graph and to ship two community files that supply-chain scanners reward.

### Changed

- **`hono`, `x402-fetch`, `x402-hono` reclassified from `dependencies` to `devDependencies` (X402-26).** These three packages are imported only by `src/dogfood/`, `scripts/`, and `tests/` — paths excluded from `tsconfig.build.json` and therefore from the published `dist/`. The shipped tarball is byte-for-byte equivalent to 0.2.2's; the only thing that changes is what `npm i x402trace` pulls into a consumer's `node_modules/`. End-user install graph drops the entire WalletConnect / MetaMask SDK / safe-global transitive tree (the source of the 4 high + 10 medium CVE alerts on the [Socket report for 0.2.2](https://socket.dev/npm/package/x402trace)).
- **`src/cli/index.ts` `VERSION` constant** bumped 0.2.2 → 0.2.3 (kept in sync with `package.json`).

### Added

- **`CODE_OF_CONDUCT.md`** — Contributor Covenant v2.1 verbatim, contact pointed at the repo's private vulnerability reporting + maintainer email (X402-26).
- **`SECURITY.md`** — vulnerability reporting channels, response targets, scope, and an explicit "what x402trace does/doesn't do" section so reporters know what's in-bounds (X402-26).
- **README supply-chain FAQ** — one new Q&A pair pre-empting "my scanner shows transitive alerts on x402trace deps" by naming the runtime tree (`commander` + `dotenv` + `viem` + `x402`) and pointing wallet-SDK transitives to their actual source (X402-26).
- **CI publish-surface guard (X402-27)** — new `scripts/check-publish-surface.mjs` runs after `pnpm build` in CI + locally via `pnpm check:publish-surface` + as part of `prepublishOnly`. Caps the bundle at 100 files / 400 KB unpacked and forbids any file in `dist/` from importing a package listed in `devDependencies`. Locks in the X402-26 fix so dep classification can't quietly drift back.
- **Dependabot config (X402-28)** — weekly grouped npm updates (Mondays; dev-deps + production-patches bundled, semver-majors ignored) plus monthly ungrouped GitHub Actions updates. Gives us a weekly heads-up when an upstream ships a CVE patch instead of waiting for an external scanner.
- **CLAUDE.md hard rule #8 (X402-29)** — "The published bundle defines the runtime dependency set." Codifies the X402-26 lesson so future sessions don't recreate the misclassification.

### Security

- Eliminates the wallet-SDK transitive tree (`@walletconnect/*`, `@metamask/sdk`, `@safe-global/*`) from end-user installs of `x402trace`. The CVE alerts those packages carry are still real — they're just no longer dragged into `node_modules/` for a CLI that doesn't use them. Anyone running the dogfood rig or contributing locally still gets them via `devDependencies`.

### Notes

- The `dist/` is byte-for-byte the same shape as 0.2.2: 74 files, ~222 KB unpacked. Verified locally + enforced by the publish-surface CI guard going forward.
- Socket score recalibration takes a few hours after publish; Snyk a day. Predicted lift: Socket Supply Chain Security 77 → 90+, Snyk Health 27 → 35-45.
- Five tickets in the v0.2.3 batch: [X402-26](https://vahdatfardin.atlassian.net/browse/X402-26), [X402-27](https://vahdatfardin.atlassian.net/browse/X402-27), [X402-28](https://vahdatfardin.atlassian.net/browse/X402-28), [X402-29](https://vahdatfardin.atlassian.net/browse/X402-29), [X402-30](https://vahdatfardin.atlassian.net/browse/X402-30) (this release cut).

## [0.2.2] — 2026-05-13

Docs-only patch: ships the three animated GIF demos to the npm package page (npmjs.com only re-renders the README on publish). No functional changes from 0.2.1.

### Changed

- **README hero is now a live animated GIF** — the X402-15 reconciliation demo, generated from the committed asciinema cast via `agg`. Renders inline on github.com, npmjs.com, and any markdown viewer (256 KB, under X / Twitter's 15 MB cap).
- **`validate` and `explain` example sections** each now include their own demo GIF (27 KB + 36 KB) above the existing text-output blocks. Text blocks remain for AI-agent quoting and `grep`-friendly inspection.
- Three new committed asciinema source casts under `examples/cast/` (`e2e-timeout-reconciliation.cast`, `validate-demo.cast`, `explain-demo.cast`) — replayable with `asciinema play`.

## [0.2.1] — 2026-05-13

Documentation + discoverability patch. **No functional changes from 0.2.0** — same CLI behaviour, same diagnostic rules, same chain client. The bump exists so npm refreshes its search index with the new `description` + `keywords` (npm only re-indexes on publish).

### Changed

- **`package.json` `description`** — was "Local CLI for debugging x402 payment flows on Base — catches timeout reconciliation failures"; now "x402 payment debugger for Base. Detects reconciliation failures, pre-flights wallets, explains 402s." Surfaces all three product capabilities in npm search instead of just reconciliation.
- **`package.json` `keywords`** (9 → 14) — added `http-402`, `base-sepolia`, `payment-debugging`, `timeout-reconciliation`, `eip-3009`, `facilitator`, `coinbase-x402`, `agentic-payments`; removed redundant `debugging` / vague `observability` / misleading `ethereum` (Base is an L2).
- **README** — added four discoverability blocks for human + AI-agent readers:
  - "When to use x402trace" — 4 problem-statement bullets, each pattern-matching an AI agent's reasoning loop ("wallet debited but server says failed" → `proxy --reconcile`, etc.)
  - "The four subcommands at a glance" — ASCII lifecycle visual keying `validate` / `proxy` / `inspect` / `explain` to the BEFORE / DURING / POST / FAILURE phases of a payment
  - Concrete terminal output blocks for `validate` and `explain` so devs + AI agents can verify-before-install
  - Comparison table vs `xpay` / `x402scan` / `x402lint` (replaces the previous prose paragraph)
  - 4-question FAQ in the Q&A pattern AI tool-cards quote into recommendation snippets
- **`VERSION` constant** in `src/cli/index.ts` bumped 0.2.0 → 0.2.1 (kept in sync with `package.json`).

### Notes

- The live tx hash [`0x116ccf73…ba52`](https://sepolia.basescan.org/tx/0x116ccf73fa77eda19aea149606042f1e848e8afe2f719a0d2890dd2b2ff0ba52) is now above the fold in the README so crawlers / GEO snippets have a verifiable on-chain anchor.
- Release workflow's `contents: write` permission (fixed for v0.1.0) means this tag-push self-creates the GitHub Release without manual intervention.

## [0.2.0] — 2026-05-12

The v0.2 pre/post-payment debugger. v0.1 owned mid-flight (proxy) + post-settlement (reconcile); v0.2 adds pre-flight (`validate`) and offline failure diagnosis (`explain`), sharing a new pure rule engine in `src/diagnose/`. Closes pain ranks #3 (generic 402 with no error reason) and #4 (wallet-state pre-flight gap) from the X402-6 ranking. 278 tests, same Base Sepolia / `exact` EVM scope as v0.1 per [ADR-002](./DECISIONS.md#adr-002-v02-feature-pick--validate-primary--explain-paired). Apache-2.0.

### Added

- **`x402trace validate <wallet> <service-url>` (X402-21)** — read-only pre-flight before signing. Fetches the 402 challenge, queries on-chain USDC balance + EIP-3009 nonce status + wallet kind (EOA vs Smart Wallet via `getCode`), synthesises a hypothetical `PaymentPayload`, runs the diagnose engine, renders a plain-English report. Exits `0` for `would-succeed`, `2` for `would-fail`, `0` for `uncertain` (or `2` with `--strict`).
- **`x402trace explain <jsonl-log-file>` (X402-21)** — read a JSONL log produced by `proxy --reconcile`, find every exchange where `reconcile.result.kind != 'settled_on_chain'` plus every `decoder.error`, run the same rule engine against captured state, print per-failure prose with actionable fixes. CI-friendly: exits `2` if any failures rendered, `0` if log was clean.
- **`src/diagnose/` (X402-21)** — pure rule engine (no I/O, no `Date.now`). 10 rules covering network match, scheme match, recipient match, value sufficiency, `validBefore` / `validAfter` window, payer USDC balance, EIP-3009 nonce freshness, wallet kind (EOA + Smart Wallet; ERC-6492 deferred to v0.3 per ADR-002), and Base Sepolia USDC asset address. Each rule returns `pass` / `fail` / `skip`; `skip` means the context lacked the data (e.g. `explain` doesn't have live wallet state). Top-level status is `would-succeed` / `would-fail` / `uncertain` (the latter when the two critical chain-state rules are skipped).
- **Chain client extensions (X402-21)** — `getUsdcBalance(wallet)`, `isNonceConsumed(authorizer, nonce)`, `detectWalletKind(wallet)` read-only methods on `ChainClient`, plus a narrow `USDC_READ_ABI` (just `balanceOf` + `authorizationState`). Used by `validate`; reusable by future v0.3 features.
- **v0.2 feature pick (X402-20)** — ADR-002 records the decision + 4 rejected alternatives. SPEC.md § 5 flipped from "v0.2 stretch (deferred)" to "v0.2 scope" with a new v0.3 stretch list catching the deferrals. CLAUDE.md current-focus flipped to v0.2.
- **CI release workflow `contents: write` fix** — release.yml's `Create GitHub Release` step had failed on the v0.1.0 cut with HTTP 403 because the job had `contents: read`. Promoted to `write` so v0.2.0+ tag-pushes self-create the GitHub Release without manual intervention.

### Tests

- 278 total (+63 from v0.1.0's 215). New: 36 unit tests for `diagnose-rules`, 14 for `validate-command`, 9 for `explain-command`, +4 for `cli-dispatcher` covering the new subcommands.

### Notes

- `package.json` bin layout unchanged from v0.1.0 — `x402trace` resolves to four subcommands (`proxy`, `inspect`, `validate`, `explain`).
- `tsconfig.build.json` is still the published-bundle config; tarball stays ~62 files / ~156 KB.

## [0.1.0] — 2026-05-12

The v0.1 wedge: a local proxy + timeout-reconciliation engine that catches the canonical [coinbase/x402#1062](https://github.com/coinbase/x402/issues/1062) symptom — buyer is debited on-chain but the facilitator/server thinks the payment failed. Verified end-to-end on real Base Sepolia + the live `x402.org/facilitator` (tx [`0x116ccf73…ba52`](https://sepolia.basescan.org/tx/0x116ccf73fa77eda19aea149606042f1e848e8afe2f719a0d2890dd2b2ff0ba52)). 215 tests, GitHub Actions CI on Node 20 + 22, Apache-2.0.

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
- **GitHub Actions CI (X402-18)** — `.github/workflows/ci.yml` runs `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` on every PR + push to `v1` / `staging` / `main`. **Node 20 + 22 matrix**, pnpm-store cached via `actions/setup-node@v4`, 10-min job timeout, in-progress runs cancelled when a fresher commit lands on the same ref. `pnpm test` auto-skips `tests/e2e/chain-live.test.ts` (gated on `X402_E2E=1`), so the live-Base-Sepolia suite never burns testnet funds in CI. Companion `.github/workflows/release.yml` is the X402-19 substrate: tag-triggered (`v*.*.*`), runs the same quality bar, builds, and has the npm-publish step commented out until [X402-19](https://vahdatfardin.atlassian.net/browse/X402-19) wires the `NPM_TOKEN` secret. The CI badge in `README.md` (placeholder since X402-16) lights up on the first run.
- **Unit-test coverage hardening (X402-17)** — Week-4 risk-reduction pass on the decoder, reconciliation, and CLI. Per the ticket spec ("chase risk reduction, not coverage targets"), targeted the gaps that break silently: (a) the streaming decoder's dispatch logic (`createDecoder().decode()`) had zero direct tests — new `tests/unit/decoder-decoder.test.ts` (11 tests) covers settlement-header parse errors, the `outcome.rawPaymentResponseHeader` fallback path, and `proxy.error` passthrough; (b) base64 + unicode edge cases on `parsePaymentHeader` / `parseChallengeBody` / `parseSettlementHeader` mirroring the [coinbase/x402#865](https://github.com/coinbase/x402/issues/865) surface area — CJK + emoji in `description` and `extra.name` round-trip, padding-stripped base64 tolerated, JSON primitives rejected, URL-safe base64 contract documented; (c) reconciliation `extractErrorReason` paths (non-JSON rawBody, JSON without `error`, missing rawBody), the `unknown` proxy outcome branch the X402-15 demo relies on, chain-transfer race conditions (arrival before pending join, duplicate transfers after match); (d) `x402trace proxy` env-var-vs-flag precedence — extracted `resolveProxyConfig(opts, env)` as a pure function from `proxy-command.ts` (small refactor for testability), then pinned the contract from [ARCHITECTURE.md § Configuration](./ARCHITECTURE.md#configuration) with 28 unit tests across `X402TRACE_UPSTREAM`, `X402TRACE_PORT`, `X402TRACE_LOG`, `X402TRACE_RECONCILE` (including non-truthy strings), `BASE_RPC_URL`, `X402TRACE_WATCH_TIMEOUT_MS`, `X402TRACE_UPSTREAM_TIMEOUT_MS`. Pipeline: **215 tests / 4 e2e skipped** (+57 vs the X402-16 baseline). Coverage: reconciliation **97% → 100%** lines/branches/funcs, decoder **79% → 90%**, src/cli **80.8% → 82%**.
- **README rewrite (X402-16)**: replaced the pre-release skeleton with a 115-line README that hits all seven X402-16 required sections — elevator pitch, the problem (with the verbatim 502 the buyer sees), 30-second quickstart (`git clone` → `pnpm install` → `cp .env.example .env` → `./examples/e2e-timeout-reconciliation.sh`), how-it-works (4 bullets + ASCII flow diagram of proxy → server → facilitator → chain → engine), CLI reference (links to `--help` rather than duplicating), v0.2 roadmap pulled from [SPEC.md § 5](./SPEC.md#5-v02-stretch-deferred-not-killed), differentiation, contributing, license. Three badges added: Apache-2.0 license (live), GitHub Actions CI (placeholder — wires up automatically when [X402-18](https://vahdatfardin.atlassian.net/browse/X402-18) lands the workflow), npm version (placeholder — wires up automatically when [X402-19](https://vahdatfardin.atlassian.net/browse/X402-19) publishes `x402trace@0.1.0`). The captured X402-15 settlement tx [`0x116ccf73…ba52`](https://sepolia.basescan.org/tx/0x116ccf73fa77eda19aea149606042f1e848e8afe2f719a0d2890dd2b2ff0ba52) is linked from the quickstart's "what success looks like" output block; the asciinema cast is referenced by relative path for local `asciinema play` until [X402-23](https://vahdatfardin.atlassian.net/browse/X402-23) uploads it for an embeddable URL.
- **End-to-end testnet demo (X402-15)** in `examples/e2e-timeout-reconciliation.sh` + `examples/README.md` + recorded asciinema cast at `examples/cast/e2e-timeout-reconciliation.cast`. The flagship reproduction of the canonical [#1062](https://github.com/coinbase/x402/issues/1062) scenario, runnable against real Base Sepolia + the real `x402.org/facilitator`. Choreography: dogfood server with new `DEMO_SLEEP_MS=10000` knob sleeps 10s _during_ the x402-hono paymentMiddleware's protected handler — x402-hono verifies before the handler and settles after, so the post-handler /settle still broadcasts on-chain even though the proxy in front gave up at 5s. `x402trace proxy --reconcile --upstream-timeout-ms 5000` returns 502 to the client (the canonical "I thought it failed" signal), pends the exchange, watches Base Sepolia via the chain client's `subscribeUsdcTransfers`, matches the EIP-3009 nonce, and emits `RECONCILED ⚠ settled-but-server-thinks-not` with the live tx hash. **Verified end-to-end on Base Sepolia 2026-05-12** with on-chain settlement tx [`0x116ccf73…ba52`](https://sepolia.basescan.org/tx/0x116ccf73fa77eda19aea149606042f1e848e8afe2f719a0d2890dd2b2ff0ba52) (block 41402768) — captured in the committed asciinema cast; reconcile gap from proxy timeout to chain-detected was **11.9 seconds**. New `--upstream-timeout-ms` CLI flag on `x402trace proxy` exposes `ProxyOptions.upstreamTimeoutMs` to the surface. New `demoSleepMs` / `demoFailAfterSleep` fields on `DogfoodConfig` plus `DEMO_SLEEP_MS` / `DEMO_FAIL_AFTER_SLEEP` env wiring in `loadServerConfig` (`demoFailAfterSleep` is documented but NOT used in the canonical demo because x402-hono skips /settle on 5xx responses). 9 new tests — 8 unit tests covering env validation (positive/negative/zero/non-numeric) and CLI help inclusion, plus 1 hermetic integration test (`tests/integration/demo-timeout-reconciliation.test.ts`) that reproduces the full demo storyline against the mock facilitator with a synthetic `ChainTransfer`. Pipeline: 158 tests / 4 e2e skipped, typecheck + lint clean. README rewritten with a quick-demo hero section.
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

[Unreleased]: https://github.com/fardinvahdat/x402trace/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/fardinvahdat/x402trace/releases/tag/v0.3.0
[0.2.3]: https://github.com/fardinvahdat/x402trace/releases/tag/v0.2.3
[0.2.2]: https://github.com/fardinvahdat/x402trace/releases/tag/v0.2.2
[0.2.1]: https://github.com/fardinvahdat/x402trace/releases/tag/v0.2.1
[0.2.0]: https://github.com/fardinvahdat/x402trace/releases/tag/v0.2.0
[0.1.0]: https://github.com/fardinvahdat/x402trace/releases/tag/v0.1.0
