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
