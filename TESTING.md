# TESTING.md — Testing philosophy and conventions

> **Rule of thumb:** A change isn't done until you have proven, with tests, that (a) it works, and (b) nothing else broke. This applies to every kind of change — code, docs, config, CI, release.

This document defines what "thorough testing" means for x402trace, change-type by change-type. It is the operational definition of the hard rule in [CLAUDE.md](./CLAUDE.md).

---

## Test categories

### Unit tests — `tests/unit/**`

- Single function or single class
- No I/O, no network, no filesystem
- Mock all external dependencies (RPC, facilitator, env)
- Should run in < 100ms each
- Tool: **vitest**
- Run: `pnpm test:unit`

### Integration tests — `tests/integration/**`

- Multiple components working together
- May use real filesystem; may use mocked RPC and mocked facilitator (a local Express server in the test harness)
- Should run in < 5s each
- Run: `pnpm test:integration`

### End-to-end tests — `tests/e2e/**`

- Full pipeline against **Base Sepolia**
- Requires testnet wallet with USDC and an `BASE_RPC_URL` set in CI secrets
- Run in CI on push to `v1`, `staging`, `main` — **not** on every PR (would burn faucet money and slow PR feedback)
- Run locally: `pnpm test:e2e`

### Smoke tests — `tests/smoke/**`

- `--help` and `--version` work
- CLI starts without crashing
- Default config loads
- Run on every PR
- Should run in < 10s total
- Run: `pnpm test:smoke`

### Manual checklist — every PR

The PR template enforces this. Each PR must check off:

- [ ] Ran `pnpm test` locally, all green
- [ ] Ran `pnpm typecheck`, no errors
- [ ] Ran `pnpm lint`, no errors
- [ ] Manually verified the user-facing change (paste output in the PR)
- [ ] Updated relevant docs (README, SPEC, ARCHITECTURE, CLAUDE.md)
- [ ] Added/updated tests covering the change

---

## What to test, by change type

### Code change to an existing module

1. Unit tests for the new behavior
2. Unit tests for **at least one error path** the change introduces or could trigger
3. Existing tests still pass (regression check)
4. If the module has a public API: an integration test exercising it
5. If the change is user-facing: a screenshot or terminal paste in the PR

### New module

1. Unit tests covering: happy path, error path, edge cases (empty input, malformed input, very-large input)
2. Integration test against at least one real consumer
3. Type definitions exported and used in at least one test (proves the types are usable from outside)
4. Documentation in ARCHITECTURE.md updated

### Bug fix

1. A test that **fails on the current main** and **passes on this branch**
2. Test name describes the bug clearly (`decoder rejects truncated signature without crashing`, not `test bug fix 3`)
3. Note in CHANGELOG.md under `[Unreleased] → Fixed`

### Documentation change

1. Markdown linter passes (`pnpm lint:docs`)
2. All internal links resolve
3. External links resolve when run quarterly (`pnpm lint:links`); not enforced per PR
4. Code blocks marked as runnable actually run

### Configuration change (`.env.example`, `tsconfig.json`, `package.json`)

1. Build still works: `pnpm build`
2. Tests still pass: `pnpm test`
3. If a new env var is introduced: documented in `.env.example` **and** referenced in CLAUDE.md
4. If a new dependency is added: justified in the PR description (why this lib, why not the standard library)

### CI change (`.github/workflows/**`)

1. Open a draft PR first so the workflow runs
2. Verify all matrix combinations pass
3. Verify failure modes fail correctly — push a deliberately-broken commit to a throwaway branch and confirm CI fails red

### Release change (version bump, CHANGELOG)

1. `npm pack --dry-run` shows the expected files (no `tests/`, no `.env`, no source maps unless intended)
2. `pnpm test` green across the full suite
3. `pnpm test:e2e` green on testnet
4. Install the packed tarball locally and run `--help`: `npm pack && npm install -g ./x402trace-*.tgz && x402trace --help`

---

## Coverage

- **No enforced minimum until v0.2.** Don't game coverage before there's signal about what matters.
- Coverage report runs in CI on every PR for visibility (via `vitest --coverage`).
- **New code should not decrease overall coverage by more than 1 percentage point** without explicit justification in the PR.

---

## When tests are hard to write

If you find yourself unable to test a change cleanly, **that's a design signal. Stop. Refactor for testability before continuing.**

Common causes and fixes:

| Symptom | Cause | Fix |
| --- | --- | --- |
| Need to mock 5 things to test 1 function | Tight coupling | Inject dependencies; pass them as parameters |
| Test depends on system time | Hardcoded `Date.now()` | Inject a `Clock` interface, pass real clock in prod, fake clock in tests |
| Test depends on the network | Direct fetch call | Inject an HTTP client |
| Test needs a specific Node version | Reliance on undocumented runtime behavior | Use stable APIs only |
| Test passes/fails based on order | Shared module state | Encapsulate state in a class or factory |

**Untested code is code that we don't yet know works.**

---

## Test data

- Real x402 payloads captured from dogfooding go in `tests/fixtures/`
- **Redact private keys and signatures before committing fixtures.** Run `pnpm lint:fixtures` to catch obvious leaks.
- One fixture per scenario, named for what it tests:
  - ✅ `payment-required-v2-base-sepolia.json`
  - ❌ `test1.json`
- When generating new fixtures, use the dogfood rig (X402-3) and `x402trace inspect` to capture them deterministically.

---

## Mocking guidelines

- **Mock at the boundary, not deep inside.** Mock the interface a module talks to the outside world through, not its internal helpers.
- **For chain RPC:** mock the viem client interface, not individual RPC method calls.
- **For the facilitator:** use a local Express server in integration tests, not deep mocks. The server can return canned responses but is a real HTTP target — this catches serialization bugs.
- **For environment variables:** use `vi.stubEnv()`, never write to `process.env` directly in tests.

---

## Running tests

```bash
pnpm test              # all tests (no coverage)
pnpm test:unit         # fast feedback while coding
pnpm test:integration  # before pushing
pnpm test:e2e          # before opening a release PR
pnpm test:smoke        # sanity check
pnpm test:watch        # TDD mode
pnpm test:coverage     # with coverage report
```

---

## CI

The CI workflow (`.github/workflows/ci.yml`, see Jira X402-18) runs on every PR:

- Lint (`pnpm lint`)
- Typecheck (`pnpm typecheck`)
- Unit tests
- Integration tests
- Smoke tests
- Build

The CI workflow runs additionally on push to `v1`, `staging`, `main`:

- E2E tests against Base Sepolia
- Coverage report

E2E and coverage do **not** run on PR commits to keep PR feedback fast (~2 minutes target).

---

## Test naming

Tests are documentation. Their names should make a failing test report read like a list of broken promises:

✅ Good:
```
decoder rejects truncated signature without crashing
reconciliation reports 'settled' when facilitator timed out but tx confirmed
CLI exits with code 2 when --upstream is missing
```

❌ Bad:
```
test1
test decoder
should work
```

---

## Anti-patterns

The following are **not allowed**:

- `test.skip(...)` left in the codebase without a linked Jira ticket explaining why
- `setTimeout` in tests instead of awaiting promises
- Tests that depend on test execution order
- Tests that hit mainnet
- Tests that hit a real third-party facilitator on every run (use the local mock server)
- "I'll write the tests in the next PR"
