/**
 * X402-35 — `x402trace validate --diff <facilitators>` cross-facilitator
 * drift detection.
 *
 * Runs the same hypothetical payload through multiple facilitators'
 * `/verify` endpoints in parallel and surfaces drift. Reuses the
 * X402-33 facilitator-aware diagnose rules per-facilitator so the same
 * single-facilitator validate output shape extends naturally to N.
 *
 * Wire shape: POST {paymentPayload, paymentRequirements} to <facilitator>/verify,
 * parse the response into a `FacilitatorInteraction`, run rules with
 * that context. The payload is the same `--validate`-synthesised one
 * (no real signature) — facilitators will reject it, but the REJECTION
 * SHAPE is the drift signal (CDP's generic invalid_payload vs xpay's
 * specific invalidReason vs PayAI's own format).
 *
 * Audience: TerraDeed switched CDP → xpay specifically because of the
 * self-payment rejection (Discord). `--diff` is the tool that would
 * have given them the answer in one command.
 */

import type {
  DiagnosticContext,
  DiagnosticReport,
  FacilitatorInteraction,
} from "../diagnose/types.js";
import { diagnose } from "../diagnose/index.js";

export interface FacilitatorEntry {
  /** Stable identifier (alias) or hostname-derived label. */
  readonly id: string;
  /** Base URL of the facilitator (no trailing slash). */
  readonly baseUrl: string;
  /** Full URL the /verify call hits. */
  readonly verifyUrl: string;
}

/**
 * Best-effort facilitator alias table. URLs are accurate to public
 * docs as of 2026-05; user can always pass a full URL to override.
 *
 *   - `cdp`      → CDP facilitator (Coinbase Developer Platform).
 *                  Endpoint: /platform/v2/x402/verify per CDP docs.
 *   - `xpay`     → xpay.org facilitator. (TerraDeed's target after
 *                  switching from CDP.)
 *   - `payai`    → PayAI facilitator. (Mentioned in #2184.)
 *   - `x402.org` → reference facilitator (works against Sepolia per
 *                  akiyama's tx 0x897dbf2589…).
 */
const FACILITATOR_ALIASES: Record<string, FacilitatorEntry> = {
  cdp: {
    id: "cdp",
    baseUrl: "https://api.cdp.coinbase.com",
    verifyUrl: "https://api.cdp.coinbase.com/platform/v2/x402/verify",
  },
  xpay: {
    id: "xpay",
    baseUrl: "https://xpay.org/facilitator",
    verifyUrl: "https://xpay.org/facilitator/verify",
  },
  payai: {
    id: "payai",
    baseUrl: "https://payai.network/facilitator",
    verifyUrl: "https://payai.network/facilitator/verify",
  },
  "x402.org": {
    id: "x402.org",
    baseUrl: "https://x402.org/facilitator",
    verifyUrl: "https://x402.org/facilitator/verify",
  },
};

/**
 * Parse the `--diff` flag value into a list of facilitator entries.
 * Accepts a comma-separated list of aliases (`cdp,xpay`) OR full URLs
 * (`https://my-fac.example/verify`). Unknown aliases produce a usage
 * error.
 */
export function parseFacilitatorList(
  raw: string,
): { ok: true; facilitators: FacilitatorEntry[] } | { ok: false; message: string } {
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (items.length < 2) {
    return {
      ok: false,
      message: `--diff requires at least two facilitators (comma-separated). Got '${raw}'.`,
    };
  }
  const result: FacilitatorEntry[] = [];
  for (const item of items) {
    if (item.toLowerCase() in FACILITATOR_ALIASES) {
      result.push(FACILITATOR_ALIASES[item.toLowerCase()]!);
      continue;
    }
    // Full URL path
    try {
      const u = new URL(item);
      const verifyUrl = item.endsWith("/verify") ? item : `${item.replace(/\/$/, "")}/verify`;
      result.push({
        id: u.host,
        baseUrl: item.replace(/\/$/, ""),
        verifyUrl,
      });
    } catch {
      return {
        ok: false,
        message: `--diff entry '${item}' is not a known alias (${Object.keys(FACILITATOR_ALIASES).join(", ")}) or a valid URL.`,
      };
    }
  }
  return { ok: true, facilitators: result };
}

/** Re-exported for help text / docs. */
export function knownFacilitatorAliases(): readonly string[] {
  return Object.keys(FACILITATOR_ALIASES);
}

export interface VerifyPayload {
  readonly paymentPayload: unknown;
  readonly paymentRequirements: unknown;
}

export type DiffFetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<Response>;

/**
 * POST to one facilitator's /verify and capture the response into a
 * `FacilitatorInteraction` suitable for feeding diagnose rules.
 *
 * Per-facilitator outcomes (encoded into the returned `interaction`):
 *
 *   - HTTP 200 with body.isValid === true → accepted (rare without a
 *     real signature)
 *   - HTTP 200 with body.isValid === false → rejected with reason
 *   - HTTP 4xx/5xx → rejected with status + body captured as
 *     errorMessage
 *   - Network failure → captured as statusCode 0 + errorMessage
 *
 * Timeout: caller supplies `AbortSignal`; on timeout the interaction
 * returns statusCode 0 + errorMessage 'timeout'.
 */
export async function callFacilitatorVerify(
  facilitator: FacilitatorEntry,
  payload: VerifyPayload,
  opts: { fetcher?: DiffFetcher; timeoutMs?: number } = {},
): Promise<FacilitatorInteraction> {
  const fetcher: DiffFetcher = opts.fetcher ?? ((url, init) => fetch(url, init));
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(facilitator.verifyUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const headerMap: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headerMap[key.toLowerCase()] = value;
    });
    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch {
      bodyText = "";
    }
    let parsedBody: unknown = undefined;
    if (bodyText.length > 0) {
      try {
        parsedBody = JSON.parse(bodyText);
      } catch {
        parsedBody = undefined;
      }
    }
    const responseObj =
      typeof parsedBody === "object" && parsedBody !== null
        ? (parsedBody as Record<string, unknown>)
        : undefined;
    const result: FacilitatorInteraction = {
      url: facilitator.verifyUrl,
      stage: "verify",
      statusCode: response.status,
      headers: headerMap,
      ...(responseObj
        ? {
            response: {
              ...(typeof responseObj["success"] === "boolean"
                ? { success: responseObj["success"] as boolean }
                : {}),
              ...(typeof responseObj["isValid"] === "boolean"
                ? { isValid: responseObj["isValid"] as boolean }
                : {}),
              ...(typeof responseObj["invalidReason"] === "string"
                ? { invalidReason: responseObj["invalidReason"] as string }
                : {}),
              ...(typeof responseObj["errorReason"] === "string"
                ? { errorReason: responseObj["errorReason"] as string }
                : {}),
              ...(typeof responseObj["payer"] === "string"
                ? { payer: responseObj["payer"] as string }
                : {}),
            },
          }
        : {}),
      ...(bodyText && !responseObj ? { errorMessage: bodyText.slice(0, 500) } : {}),
    };
    return result;
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      url: facilitator.verifyUrl,
      stage: "verify",
      statusCode: 0,
      errorMessage: isAbort
        ? `timeout after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface FacilitatorDiff {
  readonly facilitator: FacilitatorEntry;
  readonly interaction: FacilitatorInteraction;
  readonly diagnostics: DiagnosticReport;
  /** True iff the facilitator returned 200 + isValid:true (accepted). */
  readonly accepted: boolean;
  /** True iff the call timed out / never reached the facilitator. */
  readonly timedOut: boolean;
}

export interface DiffAggregate {
  readonly results: readonly FacilitatorDiff[];
  /** Verdict for exit-code purposes. */
  readonly verdict: DiffVerdict;
}

export type DiffVerdict =
  | { readonly kind: "any_accepts"; readonly accepted: readonly string[]; readonly exitCode: 0 }
  | {
      readonly kind: "all_reject";
      readonly rejected: readonly string[];
      readonly exitCode: 2;
    }
  | { readonly kind: "all_timeout"; readonly exitCode: 3 };

/**
 * Run `--diff` across N facilitators in parallel, render each result
 * through the diagnose engine with X402-33's facilitator-aware rules,
 * synthesise the verdict.
 */
export async function runFacilitatorDiff(
  facilitators: readonly FacilitatorEntry[],
  payload: VerifyPayload,
  baseCtx: Omit<DiagnosticContext, "facilitator">,
  opts: { fetcher?: DiffFetcher; timeoutMs?: number } = {},
): Promise<DiffAggregate> {
  const results = await Promise.all(
    facilitators.map(async (f): Promise<FacilitatorDiff> => {
      const interaction = await callFacilitatorVerify(f, payload, opts);
      const diagCtx: DiagnosticContext = { ...baseCtx, facilitator: interaction };
      const diagnostics = diagnose(diagCtx);
      const accepted =
        interaction.statusCode >= 200 &&
        interaction.statusCode < 300 &&
        interaction.response?.isValid === true;
      const timedOut =
        interaction.statusCode === 0 && (interaction.errorMessage ?? "").startsWith("timeout");
      return { facilitator: f, interaction, diagnostics, accepted, timedOut };
    }),
  );
  return { results, verdict: synthesiseDiffVerdict(results) };
}

function synthesiseDiffVerdict(results: readonly FacilitatorDiff[]): DiffVerdict {
  const accepted = results.filter((r) => r.accepted).map((r) => r.facilitator.id);
  if (accepted.length > 0) {
    return { kind: "any_accepts", accepted, exitCode: 0 };
  }
  if (results.every((r) => r.timedOut)) {
    return { kind: "all_timeout", exitCode: 3 };
  }
  return {
    kind: "all_reject",
    rejected: results.map((r) => r.facilitator.id),
    exitCode: 2,
  };
}
