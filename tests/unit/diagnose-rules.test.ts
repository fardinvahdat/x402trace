/**
 * X402-21 v0.2 diagnose engine — rule-level tests.
 *
 * Every rule needs at least its pass / fail / skip paths covered.
 * The integration of all rules through `diagnose()` is covered
 * separately so a rule-level regression fails loudly without
 * dragging in the orchestration code.
 */
import { describe, expect, it } from "vitest";
import {
  ALL_RULES,
  assetAddressRule,
  cdpMinAmountRule,
  diagnose,
  extensionResponsesMissingRule,
  facilitatorThrottlingRule,
  gasEstimationFailureRule,
  networkMatchRule,
  nonceFreshRule,
  payerBalanceRule,
  recipientMatchRule,
  schemeMatchRule,
  selfPaymentRule,
  validAfterRule,
  validBeforeRule,
  valueSufficientRule,
  walletKindRule,
} from "../../src/diagnose/rules.js";
import type {
  DiagnosticContext,
  DiagnosticRule,
  FacilitatorInteraction,
} from "../../src/diagnose/types.js";
import type { PaymentPayload, PaymentRequirements } from "../../src/decoder/types.js";

const PAYER = "0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895" as const;
const PAYEE = "0x1111111111111111111111111111111111111111" as const;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const NONCE = `0x${"f".repeat(64)}` as const;
const NOW = new Date("2026-05-12T00:00:00Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

function requirements(over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "base-sepolia",
    maxAmountRequired: "1000",
    resource: "http://example.test/api/weather",
    payTo: PAYEE,
    asset: USDC,
    maxTimeoutSeconds: 300,
    ...over,
  };
}

function payment(authOver = {}, payloadOver = {}): PaymentPayload {
  return {
    x402Version: 1,
    scheme: "exact",
    network: "base-sepolia",
    payload: {
      signature: "0x" + "f".repeat(130),
      authorization: {
        from: PAYER,
        to: PAYEE,
        value: "1000",
        validAfter: "0",
        validBefore: String(NOW_SEC + 300),
        nonce: NONCE,
        ...authOver,
      },
    },
    ...payloadOver,
  };
}

function ctx(over: Partial<DiagnosticContext> = {}): DiagnosticContext {
  return { requirements: requirements(), now: NOW, ...over };
}

function runRule(rule: DiagnosticRule, ctxOver: Partial<DiagnosticContext> = {}) {
  return rule.run(ctx(ctxOver));
}

describe("networkMatchRule", () => {
  it("passes when payment network matches requirements", () => {
    const r = runRule(networkMatchRule, { payment: payment() });
    expect(r.status).toBe("pass");
  });
  it("fails when networks differ", () => {
    const r = runRule(networkMatchRule, { payment: payment({}, { network: "base" }) });
    expect(r.status).toBe("fail");
    expect(r.fix).toMatch(/base-sepolia/);
  });
  it("skips when payment is absent (validate's static-check phase)", () => {
    const r = runRule(networkMatchRule, {});
    expect(r.status).toBe("skip");
  });
});

describe("schemeMatchRule", () => {
  it("passes when schemes match", () => {
    expect(runRule(schemeMatchRule, { payment: payment() }).status).toBe("pass");
  });
  it("fails when schemes differ", () => {
    const r = runRule(schemeMatchRule, { payment: payment({}, { scheme: "upto" }) });
    expect(r.status).toBe("fail");
    expect(r.fix).toMatch(/'exact' EVM/);
  });
});

describe("recipientMatchRule", () => {
  it("passes on exact match", () => {
    expect(runRule(recipientMatchRule, { payment: payment() }).status).toBe("pass");
  });
  it("is case-insensitive (EIP-55 vs lowercase) — addresses can come back in different casings", () => {
    const p = payment({ to: PAYEE.toUpperCase() });
    expect(runRule(recipientMatchRule, { payment: p }).status).toBe("pass");
  });
  it("fails when authorization.to and payTo differ", () => {
    const wrong = "0x2222222222222222222222222222222222222222";
    const r = runRule(recipientMatchRule, { payment: payment({ to: wrong }) });
    expect(r.status).toBe("fail");
    expect(r.fix).toMatch(new RegExp(PAYEE.slice(2, 10), "i"));
  });
});

describe("valueSufficientRule", () => {
  it("passes when signed value >= required", () => {
    expect(runRule(valueSufficientRule, { payment: payment() }).status).toBe("pass");
  });
  it("passes when signed value strictly exceeds required", () => {
    const p = payment({ value: "5000" });
    expect(runRule(valueSufficientRule, { payment: p }).status).toBe("pass");
  });
  it("fails when signed value < required", () => {
    const p = payment({ value: "100" });
    const r = runRule(valueSufficientRule, { payment: p });
    expect(r.status).toBe("fail");
    expect(r.fix).toMatch(/>= 1000/);
  });
  it("fails with a clear error when value isn't a valid integer", () => {
    const p = payment({ value: "not-a-number" });
    const r = runRule(valueSufficientRule, { payment: p });
    expect(r.status).toBe("fail");
    expect(r.message).toMatch(/not a valid integer/i);
  });
});

describe("validBeforeRule", () => {
  it("passes when validBefore is in the future", () => {
    const p = payment({ validBefore: String(NOW_SEC + 300) });
    expect(runRule(validBeforeRule, { payment: p }).status).toBe("pass");
  });
  it("fails when validBefore is in the past", () => {
    const p = payment({ validBefore: String(NOW_SEC - 60) });
    const r = runRule(validBeforeRule, { payment: p });
    expect(r.status).toBe("fail");
    expect(r.message).toMatch(/expired/);
    expect(r.fix).toMatch(/re-sign/);
  });
  it("fails with a clear message when validBefore isn't a number", () => {
    const p = payment({ validBefore: "tomorrow" });
    const r = runRule(validBeforeRule, { payment: p });
    expect(r.status).toBe("fail");
    expect(r.message).toMatch(/not a valid Unix timestamp/);
  });
});

describe("validAfterRule", () => {
  it("passes for validAfter=0 (the common default)", () => {
    const p = payment({ validAfter: "0" });
    expect(runRule(validAfterRule, { payment: p }).status).toBe("pass");
  });
  it("fails when validAfter is in the future", () => {
    const p = payment({ validAfter: String(NOW_SEC + 60) });
    const r = runRule(validAfterRule, { payment: p });
    expect(r.status).toBe("fail");
    expect(r.fix).toMatch(/validAfter <= /);
  });
});

describe("payerBalanceRule", () => {
  it("passes when wallet has enough USDC", () => {
    const r = runRule(payerBalanceRule, {
      payment: payment(),
      walletState: { usdcBalance: 5_000_000n }, // 5 USDC raw
    });
    expect(r.status).toBe("pass");
  });
  it("fails when wallet is short and includes the shortfall in the fix", () => {
    const r = runRule(payerBalanceRule, {
      payment: payment(),
      walletState: { usdcBalance: 100n },
    });
    expect(r.status).toBe("fail");
    expect(r.message).toMatch(/short by 900/);
    expect(r.fix).toMatch(/900 more USDC/);
  });
  it("skips when wallet state isn't available (explain's offline mode)", () => {
    const r = runRule(payerBalanceRule, { payment: payment() });
    expect(r.status).toBe("skip");
  });
});

describe("nonceFreshRule", () => {
  it("passes when the nonce has not been consumed", () => {
    const r = runRule(nonceFreshRule, {
      payment: payment(),
      walletState: { nonceConsumed: false },
    });
    expect(r.status).toBe("pass");
  });
  it("fails when the nonce has already been consumed", () => {
    const r = runRule(nonceFreshRule, {
      payment: payment(),
      walletState: { nonceConsumed: true },
    });
    expect(r.status).toBe("fail");
    expect(r.fix).toMatch(/fresh nonce/i);
  });
  it("skips when nonce status isn't known", () => {
    expect(runRule(nonceFreshRule, { payment: payment(), walletState: {} }).status).toBe("skip");
  });
});

describe("walletKindRule", () => {
  it("passes for EOA", () => {
    const r = runRule(walletKindRule, { walletState: { walletKind: "eoa" } });
    expect(r.status).toBe("pass");
  });
  it("passes for smart-wallet", () => {
    const r = runRule(walletKindRule, { walletState: { walletKind: "smart-wallet" } });
    expect(r.status).toBe("pass");
  });
  it("fails for unknown wallet kind with a v0.3 pointer", () => {
    const r = runRule(walletKindRule, { walletState: { walletKind: "unknown" } });
    expect(r.status).toBe("fail");
    expect(r.fix).toMatch(/ERC-6492|v0\.3/);
  });
  it("skips when wallet kind isn't in context (explain doesn't fetch it)", () => {
    expect(runRule(walletKindRule, {}).status).toBe("skip");
  });
});

describe("assetAddressRule", () => {
  it("passes when requirements.asset is the canonical Base Sepolia USDC", () => {
    expect(runRule(assetAddressRule, {}).status).toBe("pass");
  });
  it("is case-insensitive about the canonical address", () => {
    const r = runRule(assetAddressRule, {
      requirements: requirements({ asset: USDC.toLowerCase() }),
    });
    expect(r.status).toBe("pass");
  });
  it("fails when requirements.asset is a non-canonical token on Base Sepolia", () => {
    const r = runRule(assetAddressRule, {
      requirements: requirements({ asset: "0x9999999999999999999999999999999999999999" }),
    });
    expect(r.status).toBe("fail");
  });
  it("skips when the network is not base-sepolia (v0.2 scope)", () => {
    const r = runRule(assetAddressRule, {
      requirements: requirements({ network: "base" }),
    });
    expect(r.status).toBe("skip");
  });
});

// ─── X402-33 facilitator-aware rules ────────────────────────────────

function facilitator(over: Partial<FacilitatorInteraction> = {}): FacilitatorInteraction {
  return {
    stage: "settle",
    statusCode: 200,
    url: "https://x402.org/facilitator",
    response: { success: true, isValid: true },
    headers: {},
    ...over,
  };
}

describe("cdpMinAmountRule", () => {
  it("skips when no facilitator URL is in context", () => {
    const r = runRule(cdpMinAmountRule, {});
    expect(r.status).toBe("skip");
  });
  it("skips when the facilitator is not CDP", () => {
    const r = runRule(cdpMinAmountRule, {
      facilitator: facilitator({ url: "https://x402.org/facilitator" }),
    });
    expect(r.status).toBe("skip");
  });
  it("passes when CDP facilitator and amount is at the documented minimum (1000 atomic)", () => {
    const r = runRule(cdpMinAmountRule, {
      facilitator: facilitator({ url: "https://api.cdp.coinbase.com/v2/x402" }),
      requirements: requirements({ maxAmountRequired: "1000" }),
    });
    expect(r.status).toBe("pass");
  });
  it("fails when CDP facilitator and amount is below 1000 atomic ($0.001)", () => {
    const r = runRule(cdpMinAmountRule, {
      facilitator: facilitator({ url: "https://api.cdp.coinbase.com/v2/x402" }),
      requirements: requirements({ maxAmountRequired: "200" }),
    });
    expect(r.status).toBe("fail");
    expect(r.fix).toMatch(/maxAmountRequired/);
  });
  it("is case-insensitive about the CDP host", () => {
    const r = runRule(cdpMinAmountRule, {
      facilitator: facilitator({ url: "https://api.CDP.COINBASE.COM/v2/x402" }),
      requirements: requirements({ maxAmountRequired: "500" }),
    });
    expect(r.status).toBe("fail");
  });
});

describe("selfPaymentRule", () => {
  it("skips when there's no payment payload", () => {
    const r = runRule(selfPaymentRule, {});
    expect(r.status).toBe("skip");
  });
  it("passes when payer differs from payTo", () => {
    const r = runRule(selfPaymentRule, { payment: payment() });
    expect(r.status).toBe("pass");
  });
  it("fails when payer equals payTo (TerraDeed's CDP rejection case)", () => {
    const r = runRule(selfPaymentRule, {
      payment: payment({ from: PAYEE }),
    });
    expect(r.status).toBe("fail");
    expect(r.fix).toMatch(/different wallet|xpay/i);
  });
  it("is case-insensitive about address comparison", () => {
    const r = runRule(selfPaymentRule, {
      requirements: requirements({ payTo: PAYEE.toLowerCase() }),
      payment: payment({ from: PAYEE.toUpperCase() }),
    });
    expect(r.status).toBe("fail");
  });
});

describe("facilitatorThrottlingRule", () => {
  it("skips when no facilitator interaction is in context", () => {
    const r = runRule(facilitatorThrottlingRule, {});
    expect(r.status).toBe("skip");
  });
  it("passes when facilitator returned a non-throttle status (200)", () => {
    const r = runRule(facilitatorThrottlingRule, {
      facilitator: facilitator({ statusCode: 200 }),
    });
    expect(r.status).toBe("pass");
  });
  it("fails when facilitator returned 403", () => {
    const r = runRule(facilitatorThrottlingRule, {
      facilitator: facilitator({ statusCode: 403 }),
    });
    expect(r.status).toBe("fail");
    expect(r.fix).toMatch(/backoff|back off|exponential/i);
  });
  it("fails when facilitator returned 429", () => {
    const r = runRule(facilitatorThrottlingRule, {
      facilitator: facilitator({ statusCode: 429 }),
    });
    expect(r.status).toBe("fail");
  });
});

describe("extensionResponsesMissingRule", () => {
  const bazaarSettle = (headers: Record<string, string> = {}): FacilitatorInteraction =>
    facilitator({
      stage: "settle",
      statusCode: 200,
      response: { success: true, isValid: true },
      headers,
    });

  it("skips when caller did not signal expectsBazaarExtensions", () => {
    const r = runRule(extensionResponsesMissingRule, { facilitator: bazaarSettle() });
    expect(r.status).toBe("skip");
  });
  it("skips when there's no facilitator interaction", () => {
    const r = runRule(extensionResponsesMissingRule, { expectsBazaarExtensions: true });
    expect(r.status).toBe("skip");
  });
  it("skips when the facilitator stage is verify, not settle", () => {
    const r = runRule(extensionResponsesMissingRule, {
      expectsBazaarExtensions: true,
      facilitator: facilitator({ stage: "verify", statusCode: 200 }),
    });
    expect(r.status).toBe("skip");
  });
  it("skips when settle did not return 200", () => {
    const r = runRule(extensionResponsesMissingRule, {
      expectsBazaarExtensions: true,
      facilitator: facilitator({ stage: "settle", statusCode: 500 }),
    });
    expect(r.status).toBe("skip");
  });
  it("skips when response.success !== true (settle reported failure)", () => {
    const r = runRule(extensionResponsesMissingRule, {
      expectsBazaarExtensions: true,
      facilitator: facilitator({ stage: "settle", statusCode: 200, response: { success: false } }),
    });
    expect(r.status).toBe("skip");
  });
  it("passes when EXTENSION-RESPONSES header is present on a successful settle", () => {
    const r = runRule(extensionResponsesMissingRule, {
      expectsBazaarExtensions: true,
      facilitator: bazaarSettle({ "extension-responses": "bazaar=ok" }),
    });
    expect(r.status).toBe("pass");
  });
  it("is case-insensitive about the EXTENSION-RESPONSES header name", () => {
    const r = runRule(extensionResponsesMissingRule, {
      expectsBazaarExtensions: true,
      facilitator: bazaarSettle({ "EXTENSION-Responses": "anything" }),
    });
    expect(r.status).toBe("pass");
  });
  it("fails (canonical #2207) when settle succeeded but EXTENSION-RESPONSES header is absent", () => {
    const r = runRule(extensionResponsesMissingRule, {
      expectsBazaarExtensions: true,
      facilitator: bazaarSettle(),
    });
    expect(r.status).toBe("fail");
    expect(r.fix).toMatch(/#2207|upstream/i);
  });
});

describe("gasEstimationFailureRule", () => {
  it("skips when no facilitator interaction is in context", () => {
    const r = runRule(gasEstimationFailureRule, {});
    expect(r.status).toBe("skip");
  });
  it("passes when facilitator response has no gas-estimation phrase", () => {
    const r = runRule(gasEstimationFailureRule, {
      facilitator: facilitator({ response: { success: true } }),
    });
    expect(r.status).toBe("pass");
  });
  it("fails when errorMessage contains 'unable to estimate gas'", () => {
    const r = runRule(gasEstimationFailureRule, {
      facilitator: facilitator({
        statusCode: 400,
        errorMessage: "failed to send transaction: unable to estimate gas",
      }),
    });
    expect(r.status).toBe("fail");
    expect(r.fix).toMatch(/retry|backoff|upstream/i);
  });
  it("fails when the phrase appears in invalidReason (different facilitator wrap)", () => {
    const r = runRule(gasEstimationFailureRule, {
      facilitator: facilitator({
        statusCode: 400,
        response: { isValid: false, invalidReason: "unable to estimate gas — node returned 0x" },
      }),
    });
    expect(r.status).toBe("fail");
  });
  it("is case-insensitive about the error phrase", () => {
    const r = runRule(gasEstimationFailureRule, {
      facilitator: facilitator({
        statusCode: 400,
        errorMessage: "RPC: Unable To Estimate GAS",
      }),
    });
    expect(r.status).toBe("fail");
  });
});

describe("diagnose() orchestration — overall status", () => {
  function fullyPopulatedCtx(): DiagnosticContext {
    return ctx({
      payment: payment(),
      walletState: { usdcBalance: 5_000_000n, nonceConsumed: false, walletKind: "eoa" },
      // X402-33: facilitator interaction populated so the facilitator-aware
      // rules all pass instead of skipping. CDP URL + amount=1000 satisfies
      // cdp-min-amount; status 200 with success:true + EXTENSION-RESPONSES
      // header satisfies the bazaar-aware rules; no gas error → that passes.
      facilitator: {
        stage: "settle",
        statusCode: 200,
        url: "https://api.cdp.coinbase.com/v2/x402",
        response: { success: true, isValid: true },
        headers: { "extension-responses": "bazaar=ok" },
      },
      expectsBazaarExtensions: true,
    });
  }

  it("returns 'would-succeed' when all rules pass", () => {
    const report = diagnose(fullyPopulatedCtx());
    expect(report.overallStatus).toBe("would-succeed");
    expect(report.results.every((r) => r.status === "pass")).toBe(true);
  });

  it("returns 'would-fail' when any rule fails", () => {
    const report = diagnose(
      ctx({
        payment: payment({ value: "1" }),
        walletState: { usdcBalance: 5_000_000n, nonceConsumed: false, walletKind: "eoa" },
      }),
    );
    expect(report.overallStatus).toBe("would-fail");
    expect(report.results.some((r) => r.status === "fail")).toBe(true);
  });

  it("returns 'uncertain' when key on-chain checks are skipped (explain's typical case)", () => {
    // payment present, but no walletState → payer-balance + nonce-fresh skip
    const report = diagnose(ctx({ payment: payment() }));
    expect(report.overallStatus).toBe("uncertain");
    // No rule should have failed
    expect(report.results.some((r) => r.status === "fail")).toBe(false);
  });

  it("returns 'would-succeed' when key checks pass even if non-critical rules skip", () => {
    // Provide just enough to pass critical checks; wallet-kind skips.
    const report = diagnose(
      ctx({
        payment: payment(),
        walletState: { usdcBalance: 5_000_000n, nonceConsumed: false },
      }),
    );
    // wallet-kind skipped but it's not in CRITICAL_RULES, so we're still confident.
    expect(report.overallStatus).toBe("would-succeed");
  });

  it("runs rules in declaration order so output is stable for snapshots", () => {
    const report = diagnose(fullyPopulatedCtx());
    expect(report.results.map((r) => r.rule)).toEqual(ALL_RULES.map((r) => r.name));
  });
});
