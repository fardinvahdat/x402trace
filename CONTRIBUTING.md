# Contributing to x402trace

Thanks for your interest. This is a small personal project; expect things to move fast and direct.

---

## Before you start

1. Read [CLAUDE.md](./CLAUDE.md) — the operating manual
2. Read [TESTING.md](./TESTING.md) — **testing is a hard requirement**, not a nice-to-have
3. Check the [Jira board](https://vahdatfardin.atlassian.net/jira/software/projects/X402) — if your idea overlaps existing work, comment on the ticket first

---

## Setup

```bash
git clone https://github.com/fardinvahdat/x402trace
cd x402trace
pnpm install
cp .env.example .env
# Fill in BASE_RPC_URL, FACILITATOR_URL, and a testnet wallet
pnpm test
```

You'll need:

- **Node ≥ 20** (run `node -v` to check)
- **pnpm** (`npm install -g pnpm` if missing)
- **A Base Sepolia wallet** with some testnet USDC from [faucet.circle.com](https://faucet.circle.com)

---

## Workflow

1. Create a feature branch off `v1`:
   ```bash
   git checkout v1
   git pull
   git checkout -b feat/X402-13-reconciliation
   ```
   Branch naming: `<type>/X402-<n>-<short-slug>` where `<type>` is one of `feat`, `fix`, `docs`, `test`, `ci`, `chore`, `release`.

2. Make your change.

3. **Add tests per [TESTING.md](./TESTING.md). No tests, no merge.**

4. Run the local quality bar:
   ```bash
   pnpm test && pnpm lint && pnpm typecheck
   ```

5. Open a PR to `v1` (not `main`, not `staging`).

6. Fill in every section of the PR template, including the manual verification output.

---

## Code style

- TypeScript strict mode
- ESM, not CommonJS
- 2-space indent, single quotes, no semicolons (Prettier-enforced)
- One thing per file. One purpose per function. One PR per change.
- `any` is banned outside of `tests/fixtures/`

---

## Commit messages

Conventional commits, scoped to the Jira ticket where possible:

```
feat(X402-13): add timeout reconciliation for facilitator failures
fix(X402-11): handle truncated signatures without crashing
docs(X402-2): clarify branching strategy in CLAUDE.md
```

Not required, but helps when scanning history.

---

## JSON API discipline (`bazaar-check --log json`)

The `bazaar-check --log json` output is a **public API contract** as of v0.3.2 (ADR-004 Pillar 2). Downstream consumers (mapper integrations, agent filters) take a runtime dependency on the shape.

**Before merging any change that touches the JSON envelope, ask:**

1. Does this rename, remove, or reorder a field? → **shape-breaking**; requires a major-version bump + deprecation cycle. Do NOT merge without discussion.
2. Does this add a new OPTIONAL field, new check, or new `verdict.kind` value? → **additive**; OK in a minor version. Required steps:
   - Regenerate the snapshot fixture: see [`src/bazaar/json-api.md`](./src/bazaar/json-api.md#regenerating-the-snapshot-fixture)
   - Add a `### JSON API` subsection to `CHANGELOG.md` `[Unreleased]` documenting what changed
3. Did the snapshot test (`tests/integration/bazaar-check-json-api.test.ts`) fail unexpectedly? → the shape changed accidentally. Either fix the code (preferred) OR if the change was intentional, follow step 2.

**PR description self-check:**

- [ ] Did this PR change the `--log json` output shape (any way)?
- [ ] If yes, is the change additive (new optional field) or shape-breaking (rename/removal)?
- [ ] If additive: regenerated snapshot fixture + added `### JSON API` CHANGELOG entry?
- [ ] If shape-breaking: opened a deprecation issue + notified named consumers (TomSmart_ai mapper, etc.)?

### Captured-response fixture updates

Captured-response fixtures are for behavior that should be replayable without
touching a live paid endpoint. Treat each fixture as a small contract:

- Put the fixture under `tests/fixtures/bazaar/captured-responses/`.
- Include the target `serviceUrl`, `chain`, mocked `well-known`, `challenge`,
  and discovery responses needed to exercise the path.
- Capture the HTTP status, response body, and only the headers that affect the
  x402/Bazaar decision. Redact secrets, signatures, wallet payloads, auth
  headers, private customer data, and anything that would require a real payment
  to reproduce.
- State the expected `verdict`, `exitCode`, and any structured facets the test
  should assert, for example `indexing.indexer_state` or
  `propagation.metadata_propagation`.
- Re-run `tests/integration/bazaar-check-captured-responses.test.ts`; the
  harness discovers fixture files in that directory. Do not add a captured
  fixture that is not consumed by the harness or by a focused regression test.

The public JSON envelope is locked by
`tests/fixtures/bazaar/json-api-snapshot.json` and
`tests/integration/bazaar-check-json-api.test.ts`. The human contract lives in
[`src/bazaar/json-api.md`](./src/bazaar/json-api.md). If a fixture update
exposes an intentional JSON shape change, update all three together and add the
required `### JSON API` changelog entry.

### Bazaar discovery variant triage

When a report involves `extensions.bazaar`, decide which discovery shape is in
play before writing remediation copy:

1. **Body-discovery path**: the payload has BodyDiscovery-style fields such as
   `extensions.bazaar.info.input`, `extensions.bazaar.info.output`, and
   `extensions.bazaar.schema`. Missing-field guidance should name those fields.
   Do not tell these services to add MCP-style `name`/`description` when the
   detected variant is body-discovery.
2. **MCP-discovery path**: the payload does not have a complete body-discovery
   shape and is being validated as MCP-style discovery metadata. Missing-field
   guidance should stay on the MCP-style Bazaar metadata fields reported by the
   validator.
3. **Unknown path**: the shape cannot be classified cleanly. Preserve the raw
   `detail.variant: "unknown"` signal, avoid over-specific remediation copy, and
   add or adjust a fixture before changing user-facing advice.

The variant detector is in `src/bazaar/extensions-bazaar.ts`; challenge and
well-known checks consume that helper so the two surfaces stay aligned.

### No-payment-required test discipline

Default contributor proofs must be no-payment:

- Use public no-payment 402 probes, captured fixtures, mocked fetchers, or the
  local Base Sepolia e2e path documented in [TESTING.md](./TESTING.md).
- Do not send `X-PAYMENT`, payment signatures, private keys, wallet secrets, or
  live paid calls in default tests, CI, screenshots, or PR comments.
- If a change truly needs settlement behavior, keep it in the explicit testnet
  e2e path and document the command, chain, wallet funding source, and absence
  of mainnet spend in the PR body.
- If you only inspected public unauthenticated `402 Payment Required`
  challenges, say that directly in manual verification.

See [`src/bazaar/json-api.md`](./src/bazaar/json-api.md) for the full contract.

---

## Reporting bugs

Open a GitHub issue with:

- What you ran (full command)
- What you expected
- What happened (paste error or unexpected output)
- Versions: `node --version`, `pnpm --version`, `npx x402trace --version`, OS
- Minimal reproduction steps

If it's a **security issue**, email instead of filing publicly. Contact info is on the GitHub profile.

---

## License

By contributing, you agree your contributions are licensed under [Apache 2.0](./LICENSE).
