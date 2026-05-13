# Security policy

## Supported versions

x402trace is in active early development. Only the latest minor release line receives fixes.

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | :white_check_mark: |
| 0.1.x   | :x:                |
| < 0.1   | :x:                |

## Reporting a vulnerability

**Please do not open public GitHub issues for security reports.**

Use one of these private channels:

1. **GitHub Security Advisories (preferred):** open a private report at <https://github.com/fardinvahdat/x402trace/security/advisories/new>.
2. **Email:** vahdatfardin@gmail.com, subject prefixed with `[x402trace-security]`.

When reporting, please include:

- The version of x402trace affected (e.g. `0.2.2`).
- The Node.js version and operating system.
- A minimal reproduction (command line, config, sample log file).
- The observed impact and any suggested remediation.

## Response expectations

- **Acknowledgement:** within 3 business days.
- **Triage + initial assessment:** within 7 business days.
- **Fix or mitigation timeline:** communicated within 14 days of acknowledgement; severity-dependent.

x402trace is maintained by a single author on a best-effort basis. Timelines are targets, not contractual SLAs.

## Disclosure

We follow coordinated disclosure. Once a fix is released and users have had a reasonable upgrade window, the advisory will be published with credit to the reporter (unless anonymity is requested).

## Scope

In scope:

- The `x402trace` npm package and its first-party source under [`src/`](./src/).
- Examples and scripts shipped in this repository.

Out of scope:

- Vulnerabilities in transitive dependencies. Please report those to the upstream maintainer; x402trace will track and bump when a patched version is published.
- Issues in the upstream [`coinbase/x402`](https://github.com/coinbase/x402) protocol, SDKs, or facilitators. Report those to <https://github.com/coinbase/x402>.
- Issues that require physical access to the user's machine or the user already running a compromised binary.
- Anything in `src/dogfood/`, `scripts/`, or `tests/` — these are not shipped to npm and are not part of the runtime surface.

## What x402trace does and does not handle

x402trace is a **local debugging proxy**. It:

- Reads x402 protocol headers on requests it forwards.
- Reads chain state from a Base Sepolia RPC URL the user provides.
- Writes a JSONL log to disk. **By default, EIP-3009 signatures are redacted in the log;** the `--log-secrets` flag opts in to keeping raw signatures.

It does **not**:

- Sign transactions.
- Hold private keys.
- Send transactions to any chain.
- Make outbound calls to anywhere other than the upstream URL the user specifies and the RPC URL the user specifies.

If you find behavior that contradicts the above, that is a security issue and should be reported via the channels above.
