/**
 * X402-21 v0.2 diagnose engine — shared types.
 *
 * The diagnose engine is the substrate behind two subcommands per
 * [ADR-002](../../DECISIONS.md#adr-002-v02-feature-pick--validate-primary--explain-paired):
 *
 *   - `x402trace validate <wallet> <service>` — pre-flight check. The
 *     wallet hasn't signed anything yet; live chain state is queried
 *     and a *simulated* authorization is checked against the live 402
 *     challenge.
 *   - `x402trace explain <jsonl-log>` — offline diagnosis. The
 *     authorization is captured (the user already signed); we explain
 *     why it failed by running the same rules against the captured
 *     state.
 *
 * Same engine, different input populations — `validate` runs with full
 * `walletState` and a synthetic `payment`; `explain` runs with a real
 * `payment` and potentially no `walletState` (the log doesn't capture
 * balance/allowance at the time the request was made).
 *
 * Rules MUST be pure functions of the context — no I/O, no Date.now().
 * The current time enters via `ctx.now`. This lets `explain` reproduce
 * a diagnosis deterministically from a JSONL log.
 */

import type { FacilitatorResponse, PaymentPayload, PaymentRequirements } from "../decoder/types.js";

/**
 * Snapshot of the on-chain state needed to diagnose a payment. All
 * fields are optional: `validate` populates them from live RPC,
 * `explain` runs without them (since v0.1 logs don't capture chain
 * state at the moment of failure).
 */
export interface WalletState {
  /** Wallet's current USDC balance, in raw token units (no decimals applied). */
  readonly usdcBalance?: bigint;
  /**
   * Whether the authorization's nonce has already been consumed. EIP-3009
   * nonces are unique per `(authorizer, contract)`; a "true" here means
   * the wallet has already used this nonce on the USDC contract.
   */
  readonly nonceConsumed?: boolean;
  /**
   * Loose classification of the wallet behind the address. v0.2 supports
   * `eoa` and `smart-wallet`; `unknown` means we couldn't decide (treat
   * as a warning rather than a failure).
   */
  readonly walletKind?: "eoa" | "smart-wallet" | "unknown";
}

/**
 * Captured HTTP-level details from a facilitator `/verify` or `/settle`
 * call. Populated by callers that actually interact with the facilitator
 * (`bazaar-check`, `validate --diff`) so the X402-33 facilitator-aware
 * rules — CDP min amount, throttling detection, EXTENSION-RESPONSES
 * presence, gas-estimation-failure — can run. Currently NOT captured in
 * the v0.2 JSONL log shape; rules using these fields skip cleanly when
 * the field is absent (consistent with payer-balance / nonce-fresh).
 */
export interface FacilitatorInteraction {
  /** Facilitator URL the call went to (e.g. `https://api.cdp.coinbase.com`). */
  readonly url?: string;
  /** Which stage this interaction is from — `/verify` vs `/settle`. */
  readonly stage: "verify" | "settle";
  /** HTTP status code returned by the facilitator. */
  readonly statusCode: number;
  /**
   * Response headers, normalized to lowercase keys. Used by
   * `extension-responses-missing` to detect the [#2207](https://github.com/x402-foundation/x402/issues/2207)
   * pattern (settle succeeds but EXTENSION-RESPONSES header absent).
   */
  readonly headers?: Readonly<Record<string, string>>;
  /** Parsed body. Reuses the decoder's `FacilitatorResponse` shape. */
  readonly response?: FacilitatorResponse;
  /**
   * Raw error message text from the facilitator response. Used by
   * `gas-estimation-failure` to detect the [#1065](https://github.com/x402-foundation/x402/issues/1065)
   * intermittent Base-mainnet flake (`"unable to estimate gas"`).
   */
  readonly errorMessage?: string;
}

export interface DiagnosticContext {
  readonly requirements: PaymentRequirements;
  /**
   * Either a captured `PaymentPayload` (from `explain`) or a simulated
   * one (from `validate`, constructed from the wallet address +
   * requirements). When undefined, payment-side rules skip.
   */
  readonly payment?: PaymentPayload;
  readonly walletState?: WalletState;
  /**
   * The instant the diagnosis runs. Used for `validBefore` window
   * checks. Injected explicitly so the rule engine stays pure.
   */
  readonly now: Date;
  /**
   * HTTP-level details of a recent facilitator interaction. Optional;
   * the X402-33 facilitator-aware rules skip when this is absent.
   * Populated by callers like `bazaar-check` and `validate --diff` that
   * actually drive the facilitator.
   */
  readonly facilitator?: FacilitatorInteraction;
  /**
   * Caller intent flag: when `true`, the caller is validating a service
   * that should emit `extensions.bazaar` (e.g. `bazaar-check`). The
   * `extension-responses-missing` rule respects this — it skips
   * silently when the caller isn't testing bazaar integration, so
   * `explain`/`validate` on non-bazaar logs don't see false fails.
   */
  readonly expectsBazaarExtensions?: boolean;
}

export type DiagnosticStatus = "pass" | "fail" | "skip";

export interface DiagnosticResult {
  /** Stable identifier; downstream tools can grep / filter on this. */
  readonly rule: string;
  readonly status: DiagnosticStatus;
  /**
   * One-line human-readable description. On `pass` it states what was
   * verified; on `fail` it states what was wrong; on `skip` it says
   * what's missing from the context to run this check.
   */
  readonly message: string;
  /** Plain-English actionable fix. Only present when `status === "fail"`. */
  readonly fix?: string;
}

/**
 * Top-level conclusion. Distinct from the per-rule statuses because a
 * diagnosis with only `skip`s is meaningfully different from one with
 * all `pass`es.
 */
export type OverallStatus =
  /** Every applicable rule passed — the payment would (or did) succeed. */
  | "would-succeed"
  /** At least one rule failed. */
  | "would-fail"
  /** Some rules ran (no fails) but key checks were skipped — we can't be sure. */
  | "uncertain";

export interface DiagnosticReport {
  readonly results: readonly DiagnosticResult[];
  readonly overallStatus: OverallStatus;
}

/**
 * A rule is a pure function from context to result. The `name` is the
 * stable identifier surfaced in `DiagnosticResult.rule`.
 */
export interface DiagnosticRule {
  readonly name: string;
  readonly run: (ctx: DiagnosticContext) => DiagnosticResult;
}
