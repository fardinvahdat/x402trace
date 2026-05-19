/**
 * X402-21 v0.2 diagnose rules.
 *
 * Each rule answers one yes/no question about a payment context.
 * Rules are pure — no I/O, no Date.now(), no random. They return
 * `skip` when the context lacks the data they need (which happens
 * routinely: `validate` populates `walletState` but synthesises a
 * `payment`, `explain` has a captured `payment` but no live
 * `walletState`).
 *
 * Adding a rule:
 *   1. Write the function below.
 *   2. Add it to `ALL_RULES` at the bottom.
 *   3. Add a unit test in `tests/unit/diagnose-rules.test.ts`.
 *
 * A rule failing should always include a `fix` field. The fix is what
 * the user reads first when something's broken — it has to be
 * actionable.
 */

import type { DiagnosticContext, DiagnosticResult, DiagnosticRule } from "./types.js";

function pass(rule: string, message: string): DiagnosticResult {
  return { rule, status: "pass", message };
}
function fail(rule: string, message: string, fix: string): DiagnosticResult {
  return { rule, status: "fail", message, fix };
}
function skip(rule: string, message: string): DiagnosticResult {
  return { rule, status: "skip", message };
}

/**
 * Network mismatch is the most common config-level mistake — signing
 * for `base` instead of `base-sepolia` (or vice versa) fails verify
 * with a generic error that doesn't name the field. We name it loudly.
 */
export const networkMatchRule: DiagnosticRule = {
  name: "network-match",
  run(ctx) {
    if (!ctx.payment) return skip(this.name, "no payment payload to check network against");
    if (ctx.payment.network === ctx.requirements.network) {
      return pass(this.name, `network matches: ${ctx.requirements.network}`);
    }
    return fail(
      this.name,
      `payment is for ${ctx.payment.network}, but the service requires ${ctx.requirements.network}`,
      `re-sign the payment with network='${ctx.requirements.network}'`,
    );
  },
};

/**
 * Scheme mismatch — v0.1/v0.2 only support `exact` EVM per ADR-001.
 * If the requirements ask for a different scheme, that's a service-
 * side mismatch with our tool.
 */
export const schemeMatchRule: DiagnosticRule = {
  name: "scheme-match",
  run(ctx) {
    if (!ctx.payment) return skip(this.name, "no payment payload to check scheme against");
    if (ctx.payment.scheme === ctx.requirements.scheme) {
      return pass(this.name, `scheme matches: ${ctx.requirements.scheme}`);
    }
    return fail(
      this.name,
      `payment uses scheme '${ctx.payment.scheme}', service expects '${ctx.requirements.scheme}'`,
      `re-sign with the correct scheme; x402trace v0.2 only supports 'exact' EVM`,
    );
  },
};

/**
 * The recipient in the EIP-3009 authorization MUST match the service's
 * `payTo`. If not, the payment goes to the wrong address. Case-
 * insensitive — EIP-55 addresses can come back from different sources
 * in different casings.
 */
export const recipientMatchRule: DiagnosticRule = {
  name: "recipient-match",
  run(ctx) {
    if (!ctx.payment) return skip(this.name, "no payment payload");
    const authTo = ctx.payment.payload.authorization.to.toLowerCase();
    const required = ctx.requirements.payTo.toLowerCase();
    if (authTo === required) {
      return pass(this.name, `recipient matches: ${ctx.requirements.payTo}`);
    }
    return fail(
      this.name,
      `authorization.to=${ctx.payment.payload.authorization.to}, requirements.payTo=${ctx.requirements.payTo}`,
      `re-sign with to=${ctx.requirements.payTo}`,
    );
  },
};

/**
 * The signed `value` MUST cover `maxAmountRequired`. The service is
 * free to settle less than requested, but never more than authorized.
 */
export const valueSufficientRule: DiagnosticRule = {
  name: "value-sufficient",
  run(ctx) {
    if (!ctx.payment) return skip(this.name, "no payment payload");
    let signed: bigint;
    let required: bigint;
    try {
      signed = BigInt(ctx.payment.payload.authorization.value);
      required = BigInt(ctx.requirements.maxAmountRequired);
    } catch {
      return fail(
        this.name,
        `value field is not a valid integer (authorization.value=${ctx.payment.payload.authorization.value}, requirements.maxAmountRequired=${ctx.requirements.maxAmountRequired})`,
        `both fields must be base-unit integers as strings (no decimals, no 0x prefix)`,
      );
    }
    if (signed >= required) {
      return pass(this.name, `signed ${signed} >= required ${required}`);
    }
    return fail(
      this.name,
      `signed value ${signed} is less than required ${required}`,
      `re-sign with value >= ${required}`,
    );
  },
};

/**
 * `validBefore` must be in the future at diagnosis time. Expired
 * authorizations are a common failure when the user signs and then
 * the facilitator/network takes too long.
 */
export const validBeforeRule: DiagnosticRule = {
  name: "valid-before",
  run(ctx) {
    if (!ctx.payment) return skip(this.name, "no payment payload");
    const validBeforeSec = Number(ctx.payment.payload.authorization.validBefore);
    if (!Number.isFinite(validBeforeSec)) {
      return fail(
        this.name,
        `validBefore is not a valid Unix timestamp: ${ctx.payment.payload.authorization.validBefore}`,
        `set validBefore to a Unix timestamp in seconds`,
      );
    }
    const nowSec = Math.floor(ctx.now.getTime() / 1000);
    if (nowSec < validBeforeSec) {
      const remaining = validBeforeSec - nowSec;
      return pass(this.name, `validBefore=${validBeforeSec} is ${remaining}s in the future`);
    }
    const expiredBy = nowSec - validBeforeSec;
    return fail(
      this.name,
      `validBefore=${validBeforeSec} expired ${expiredBy}s ago (now=${nowSec})`,
      `re-sign the authorization with a later validBefore (typical: now + ${ctx.requirements.maxTimeoutSeconds ?? 300}s)`,
    );
  },
};

/**
 * `validAfter` must be in the past at diagnosis time. Rare in practice
 * (most signers set it to 0), but a client signing too far in the
 * future would fail to settle until then.
 */
export const validAfterRule: DiagnosticRule = {
  name: "valid-after",
  run(ctx) {
    if (!ctx.payment) return skip(this.name, "no payment payload");
    const validAfterSec = Number(ctx.payment.payload.authorization.validAfter);
    if (!Number.isFinite(validAfterSec)) {
      return fail(
        this.name,
        `validAfter is not a valid Unix timestamp: ${ctx.payment.payload.authorization.validAfter}`,
        `set validAfter to a Unix timestamp in seconds (0 is the common default)`,
      );
    }
    const nowSec = Math.floor(ctx.now.getTime() / 1000);
    if (nowSec >= validAfterSec) {
      return pass(this.name, `validAfter=${validAfterSec} (already valid)`);
    }
    const waitSec = validAfterSec - nowSec;
    return fail(
      this.name,
      `validAfter=${validAfterSec} is ${waitSec}s in the future`,
      `re-sign with validAfter <= ${nowSec} (use 0 unless you have a specific reason)`,
    );
  },
};

/**
 * Live wallet balance covers the signed value. This is the big
 * pre-flight check `validate` adds — discovered live in X402-3 when
 * our test wallet was empty.
 */
export const payerBalanceRule: DiagnosticRule = {
  name: "payer-balance",
  run(ctx) {
    if (!ctx.payment) return skip(this.name, "no payment payload");
    if (ctx.walletState?.usdcBalance === undefined) {
      return skip(
        this.name,
        "no on-chain wallet balance in context (run `validate` for live check)",
      );
    }
    let needed: bigint;
    try {
      needed = BigInt(ctx.payment.payload.authorization.value);
    } catch {
      return skip(this.name, "payment value is not a parsable bigint");
    }
    if (ctx.walletState.usdcBalance >= needed) {
      return pass(
        this.name,
        `wallet has ${ctx.walletState.usdcBalance} USDC (raw), needs ${needed}`,
      );
    }
    const shortfall = needed - ctx.walletState.usdcBalance;
    return fail(
      this.name,
      `wallet has ${ctx.walletState.usdcBalance} USDC (raw), needs ${needed} — short by ${shortfall}`,
      `fund the wallet with at least ${shortfall} more USDC (raw units)`,
    );
  },
};

/**
 * EIP-3009 nonces are single-use per `(authorizer, contract)`. A
 * re-used nonce will fail settlement — either because the previous
 * settlement already consumed it, or because the user is replaying.
 */
export const nonceFreshRule: DiagnosticRule = {
  name: "nonce-fresh",
  run(ctx) {
    if (!ctx.payment) return skip(this.name, "no payment payload");
    if (ctx.walletState?.nonceConsumed === undefined) {
      return skip(this.name, "no on-chain nonce status in context (run `validate` for live check)");
    }
    if (!ctx.walletState.nonceConsumed) {
      return pass(
        this.name,
        `nonce ${ctx.payment.payload.authorization.nonce.slice(0, 10)}… is fresh`,
      );
    }
    return fail(
      this.name,
      `nonce ${ctx.payment.payload.authorization.nonce} has already been consumed on this USDC contract`,
      `generate a fresh nonce (32 random bytes) and re-sign`,
    );
  },
};

/**
 * Wallet kind affects signature verification. EOAs sign with secp256k1
 * (verifiable by ecrecover); Smart Wallets use ERC-1271 (verifiable
 * by calling the wallet contract); ERC-6492 wraps undeployed-Smart-
 * Wallet signatures. v0.2 supports EOA + Smart Wallet detection;
 * ERC-6492 is a documented v0.3 gap.
 */
export const walletKindRule: DiagnosticRule = {
  name: "wallet-kind",
  run(ctx) {
    if (!ctx.walletState?.walletKind) {
      return skip(this.name, "wallet kind not detected (run `validate` against a live wallet)");
    }
    if (ctx.walletState.walletKind === "eoa" || ctx.walletState.walletKind === "smart-wallet") {
      return pass(this.name, `wallet kind: ${ctx.walletState.walletKind}`);
    }
    return fail(
      this.name,
      "wallet kind could not be classified",
      "v0.2 supports EOA + Smart Wallet only; ERC-6492 / unknown kinds are a v0.3 gap",
    );
  },
};

/**
 * The asset address in the authorization context must match the
 * service's required asset (USDC on Base Sepolia, `0x036C…CF7e`).
 * v0.1's PaymentPayload doesn't carry the asset directly — it lives
 * in the EIP-712 domain that signers attach implicitly — so this rule
 * cross-checks via the network: a `base-sepolia` payload implicitly
 * targets `0x036C…CF7e`.
 *
 * This is a documentation rule for now; once we capture the EIP-712
 * domain in the payment payload (v0.3) we can do a hard check.
 */
export const assetAddressRule: DiagnosticRule = {
  name: "asset-address",
  run(ctx) {
    // Best-effort: warn if requirements specify an unexpected asset
    // for base-sepolia. The standard Base Sepolia USDC is well-known.
    const BASE_SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
    if (ctx.requirements.network !== "base-sepolia") {
      return skip(
        this.name,
        `network ${ctx.requirements.network} not validated by this rule (v0.2 covers base-sepolia only)`,
      );
    }
    if (ctx.requirements.asset.toLowerCase() === BASE_SEPOLIA_USDC) {
      return pass(this.name, "asset is canonical Base Sepolia USDC");
    }
    return fail(
      this.name,
      `requirements.asset=${ctx.requirements.asset}, expected Base Sepolia USDC ${BASE_SEPOLIA_USDC}`,
      `the service is asking for payment in a non-canonical token; verify with the service operator`,
    );
  },
};

// ─── X402-33 facilitator-aware rules ────────────────────────────────
//
// These five rules cover footguns that cost Discord-cohort operators
// multi-day debugging sessions. Each maps to a named voice on Discord
// or GitHub Issues (ADR-003 evidence base). They skip when
// `ctx.facilitator` (or, for `extension-responses-missing`,
// `ctx.expectsBazaarExtensions`) is absent — so they are pure
// additions to the existing rule surface; callers that don't populate
// the facilitator interaction see no behavior change.

const CDP_FACILITATOR_HOST = "cdp.coinbase.com";
/** $0.001 USDC at 6 decimals — the documented CDP facilitator minimum.
 *  Surfaced by DukeOphir/Coinbase team in the Discord transcript after
 *  akiyama's multi-day chase of a generic `invalid_payload`.
 *
 *  **Known gap (X402-38 pre-publish audit, 2026-05-17):** the threshold
 *  was Discord-confirmed for Base Sepolia. Mainnet has not been
 *  explicitly confirmed by the Coinbase team; we apply the same minimum
 *  on the conservative assumption that the facilitator's threshold is
 *  global (not chain-specific). If a mainnet operator reports a
 *  different minimum, split into per-chain values. */
const CDP_MIN_AMOUNT_ATOMIC = 1000n;

/**
 * The CDP facilitator silently rejects payments below 1000 atomic USDC
 * units ($0.001) with a generic `invalid_payload` and no amount hint.
 * Not in the public docs as of 2026-05-13. akiyama lost multiple days
 * on this; flagging it pre-emptively is the highest-leverage diagnose
 * surface for operators on the CDP facilitator path.
 */
export const cdpMinAmountRule: DiagnosticRule = {
  name: "cdp-min-amount",
  run(ctx) {
    const url = ctx.facilitator?.url;
    if (!url) return skip(this.name, "no facilitator URL in context");
    if (!url.toLowerCase().includes(CDP_FACILITATOR_HOST)) {
      return skip(this.name, `facilitator is not CDP (${url})`);
    }
    let required: bigint;
    try {
      required = BigInt(ctx.requirements.maxAmountRequired);
    } catch {
      return skip(this.name, "requirements.maxAmountRequired is not a parsable bigint");
    }
    if (required >= CDP_MIN_AMOUNT_ATOMIC) {
      return pass(
        this.name,
        `required ${required} >= CDP minimum ${CDP_MIN_AMOUNT_ATOMIC} ($0.001 USDC)`,
      );
    }
    return fail(
      this.name,
      `required ${required} < CDP facilitator minimum ${CDP_MIN_AMOUNT_ATOMIC} ($0.001 USDC) — CDP rejects with generic invalid_payload`,
      `set maxAmountRequired >= ${CDP_MIN_AMOUNT_ATOMIC} (atomic units = $0.001 USDC) or use a non-CDP facilitator. The threshold is not in public CDP docs as of 2026-05-13.`,
    );
  },
};

/**
 * `payer == payTo` (signing from the same wallet that receives the
 * payment) is rejected by some facilitators — notably CDP returns a
 * generic invalid_payload. TerraDeed hit this on Base mainnet and had
 * to switch CDP → xpay to clear it. We catch the misconfiguration
 * pre-flight rather than letting the operator chase it.
 */
export const selfPaymentRule: DiagnosticRule = {
  name: "self-payment",
  run(ctx) {
    if (!ctx.payment) return skip(this.name, "no payment payload to check payer");
    const payer = ctx.payment.payload.authorization.from.toLowerCase();
    const payTo = ctx.requirements.payTo.toLowerCase();
    if (payer !== payTo) {
      return pass(this.name, `payer differs from payTo (no self-payment)`);
    }
    return fail(
      this.name,
      `payer and payTo are the same address: ${ctx.requirements.payTo}`,
      `self-payment is rejected by some facilitators (notably CDP returns invalid_payload). Sign from a different wallet, or route through a facilitator that allows it (e.g. xpay).`,
    );
  },
};

/**
 * Facilitator returning 403/429 without an actionable body is almost
 * always rate-limiting. The CDP facilitator has no documented rate
 * limit; tanissian hit this with 30s gaps between requests. The fix is
 * to back off — flagging the pattern saves the operator from chasing
 * payload validation.
 */
export const facilitatorThrottlingRule: DiagnosticRule = {
  name: "facilitator-throttling",
  run(ctx) {
    if (!ctx.facilitator) return skip(this.name, "no facilitator interaction in context");
    const { statusCode } = ctx.facilitator;
    if (statusCode !== 403 && statusCode !== 429) {
      return pass(this.name, `facilitator returned ${statusCode} (not a throttling code)`);
    }
    return fail(
      this.name,
      `facilitator returned HTTP ${statusCode} — likely throttling`,
      `back off and retry with exponential delay (start at 5s, double up to 60s). No documented rate limit; Discord report (tanissian) hit this with 30s gaps. If it persists, try a different facilitator.`,
    );
  },
};

/**
 * The canonical [#2207](https://github.com/x402-foundation/x402/issues/2207)
 * cluster: settlement succeeds (200 + success:true), on-chain tx
 * confirms, but the response is missing the `EXTENSION-RESPONSES`
 * header — and as a result, Bazaar / agentic.market never indexes the
 * service. 6+ independent reporters in the GitHub thread. The rule
 * fires only when the caller has set `expectsBazaarExtensions: true`
 * (so non-bazaar callers don't see spurious fails).
 */
export const extensionResponsesMissingRule: DiagnosticRule = {
  name: "extension-responses-missing",
  run(ctx) {
    if (!ctx.expectsBazaarExtensions) {
      return skip(this.name, "caller did not signal expectsBazaarExtensions");
    }
    if (!ctx.facilitator) return skip(this.name, "no facilitator interaction in context");
    if (ctx.facilitator.stage !== "settle") {
      return skip(this.name, `interaction stage is ${ctx.facilitator.stage}, not settle`);
    }
    if (ctx.facilitator.statusCode !== 200) {
      return skip(this.name, `settle returned ${ctx.facilitator.statusCode}, not 200`);
    }
    if (ctx.facilitator.response?.success !== true) {
      return skip(this.name, "settle response did not report success:true");
    }
    const headers = ctx.facilitator.headers ?? {};
    const hasExtensionResponses = Object.keys(headers).some(
      (k) => k.toLowerCase() === "extension-responses",
    );
    if (hasExtensionResponses) {
      return pass(this.name, "EXTENSION-RESPONSES header present on successful settle");
    }
    return fail(
      this.name,
      "settle succeeded on-chain but response did NOT include EXTENSION-RESPONSES header — this is the upstream #2207 bug, not your implementation",
      `your service implementation looks correct. The missing header is an upstream CDP facilitator bug tracked at https://github.com/x402-foundation/x402/issues/2207 (94 comments, 6+ independent reporters). Bazaar indexing requires this header; until CDP ships a fix, manual ecosystem listing via the foundation team is the workaround.`,
    );
  },
};

/**
 * "Unable to estimate gas" errors on `/settle` are an intermittent
 * Base-mainnet failure mode tracked in [#1065](https://github.com/x402-foundation/x402/issues/1065):
 * 40% success rate with identical nonces, signatures, EIP-712 domain.
 * Dev.to (mkmkkkkk) independently quotes ~60% failure rate. The pattern
 * is non-deterministic — operators chase it as if it were a code bug
 * for days before realizing it's upstream chain/facilitator flake.
 * Catching the error text saves the chase.
 */
const GAS_ESTIMATION_ERROR_PHRASE = "unable to estimate gas";
export const gasEstimationFailureRule: DiagnosticRule = {
  name: "gas-estimation-failure",
  run(ctx) {
    if (!ctx.facilitator) return skip(this.name, "no facilitator interaction in context");
    const haystack = [
      ctx.facilitator.errorMessage,
      ctx.facilitator.response?.invalidReason,
      ctx.facilitator.response?.errorReason,
    ]
      .filter((s): s is string => typeof s === "string")
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(GAS_ESTIMATION_ERROR_PHRASE)) {
      return pass(this.name, "no gas-estimation error pattern detected");
    }
    return fail(
      this.name,
      `facilitator returned an 'unable to estimate gas' error — known intermittent Base-mainnet flake (GitHub #1065 reports 40% failure with identical code)`,
      `retry with exponential backoff (start at 3s, double up to 30s). This is upstream of x402trace; your code is fine. Pattern is non-deterministic across identical requests — multiple Discord/Dev.to reports converge on ~40-60% failure rate.`,
    );
  },
};

export const ALL_RULES: readonly DiagnosticRule[] = [
  networkMatchRule,
  schemeMatchRule,
  recipientMatchRule,
  valueSufficientRule,
  validBeforeRule,
  validAfterRule,
  payerBalanceRule,
  nonceFreshRule,
  walletKindRule,
  assetAddressRule,
  cdpMinAmountRule,
  selfPaymentRule,
  facilitatorThrottlingRule,
  extensionResponsesMissingRule,
  gasEstimationFailureRule,
];

/**
 * Apply every rule in `rules` to `ctx`. Returns the per-rule results
 * in declaration order plus an overall status:
 *
 *   - `would-succeed`: at least one `pass`, no `fail`s, no critical `skip`s
 *   - `would-fail`:    at least one `fail`
 *   - `uncertain`:     no `fail`s but critical checks were skipped (e.g.
 *     `validate` couldn't reach the chain, so balance + nonce were
 *     skipped — we can't claim the payment would succeed)
 *
 * "Critical" skips are the on-chain-state rules — `payer-balance` and
 * `nonce-fresh`. Pure-static checks skipping just means the rule
 * doesn't apply (e.g. no payment payload to check signature against).
 */
const CRITICAL_RULES = new Set(["payer-balance", "nonce-fresh"]);

export function diagnose(
  ctx: DiagnosticContext,
  rules: readonly DiagnosticRule[] = ALL_RULES,
): { results: DiagnosticResult[]; overallStatus: "would-succeed" | "would-fail" | "uncertain" } {
  const results = rules.map((r) => r.run(ctx));
  const anyFail = results.some((r) => r.status === "fail");
  if (anyFail) return { results, overallStatus: "would-fail" };
  const criticalSkipped = results.some((r) => r.status === "skip" && CRITICAL_RULES.has(r.rule));
  if (criticalSkipped) return { results, overallStatus: "uncertain" };
  return { results, overallStatus: "would-succeed" };
}
