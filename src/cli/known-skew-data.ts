/**
 * X402-36 — bundled known-skew dataset for the `versions` subcommand.
 *
 * Inlined as TS constants (rather than imported JSON) so the dataset
 * ships in `dist/` without requiring tsc to copy non-TS assets, and
 * tests can inject overrides cleanly via `--knownSkew` injection.
 *
 * **Curation rule**: each entry must have a documented, named source
 * — a GitHub issue, a Discord transcript pointer, or a real
 * Dev.to/blog post. No guesses. Entries without a real source are
 * worse than no entry (they create false-positive noise).
 */

import type { KnownSkewDataset } from "./versions-command.js";

export const BUNDLED_KNOWN_SKEW: KnownSkewDataset = {
  version: 1,
  entries: [
    {
      id: "x402-fetch-2.10.0-extensions-echo",
      package: "@x402/fetch",
      match: "exact",
      version: "2.10.0",
      severity: "warning",
      summary:
        "@x402/fetch 2.10.0 does not echo extensions (e.g. extensions.bazaar) into the paymentPayload it submits, so the facilitator never gets the bazaar context on /settle and the listing never indexes",
      fix: "upgrade to @x402/fetch 2.11.0 or later. Poteshniy reported this on Discord and resolved AgentTrust indexing after the bump.",
      evidence: "https://github.com/x402-foundation/x402/issues/2157",
    },
    {
      id: "x402-hono-syncFacilitatorOnStart-default",
      package: "@x402/hono",
      match: "any",
      severity: "warning",
      summary:
        "@x402/hono's paymentMiddleware defaults syncFacilitatorOnStart to true; this triggers discovery probes during boot that can race with the facilitator config and crash init",
      fix: "pass syncFacilitatorOnStart: false to paymentMiddleware. Discord (Poteshniy) hit this on AgentTrust.",
      evidence: "https://github.com/x402-foundation/x402/issues/2157",
    },
    {
      id: "python-sdk-bazaar-extensions",
      package: "python:x402",
      match: "any",
      severity: "blocking",
      summary:
        "Pre-v2 Python x402 SDK does not emit extensions.bazaar correctly on the 402 challenge; the listing on agentic.market falls back to raw URLs and never gets indexed",
      fix: "refactor to the TypeScript v2 SDK (@x402/hono or @x402/express). Myceliaman14 in the Discord transcript: 'Python SDK was a bit of a stepchild' — refactored to TS v2 to fix",
      evidence: "https://github.com/x402-foundation/x402/issues/2207",
    },
  ],
};
