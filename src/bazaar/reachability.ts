/**
 * X402-52 (v0.3.4 I, ADR-006) — reachability check + service_unreachable verdict.
 *
 * Probes the service URL at the network layer (DNS / TCP / TLS / HTTP)
 * with bounded timeout + bounded retry for transient 5xx. Classifies
 * the outcome into one of:
 *
 *   - `ok` — 2xx / 3xx / 4xx within timeout (service is responsive)
 *   - `dns_failure` — NXDOMAIN, no A/AAAA records
 *   - `tcp_refused` — DNS resolved, port connect refused or host
 *     unreachable
 *   - `tls_error` — TCP connected, TLS handshake failed (cert / ALPN /
 *     protocol)
 *   - `timeout` — TCP connected, no response within bounded window
 *   - `persistent_5xx` — service responded with 5xx ≥3 times within
 *     the bounded retry loop (within ONE probe attempt). Out-of-band:
 *     this is a server-malfunction signal, NOT an unreachability one;
 *     rolls up to existing `upstream_issue` verdict, NOT
 *     `service_unreachable`.
 *
 * **Multi-probe consensus** (ADR-006 § Decision):
 *
 * Single-probe failure does NOT promote to top-level
 * `service_unreachable`. The verdict synthesizer requires N consecutive
 * matching probes within a per-cause consensus window — read from a
 * JSONL log via the `probeHistoryLog` option. When no log is provided
 * OR no prior history matches, the facet emits with
 * `state: unreachable_first_probe` + INFO note, NOT top-level.
 *
 * Per-cause consensus windows (locked 2026-05-29 with TomSmart_ai
 * endorsement; see `probe-history.ts` PER_CAUSE_INTERVAL_MS):
 *
 *   - dns_failure: 5 min  (DNS TTLs fast; NXDOMAIN cleanest signal)
 *   - tcp_refused: 15 min (LB reaping, deploy churn)
 *   - tls_error:   30 min (TLS-1.3 / ALPN / cert rotation)
 *   - timeout:     15 min (transient class same as tcp_refused)
 *   - persistent_5xx: n/a (out-of-band, never cross-probe)
 *
 * Operators scale all windows uniformly via
 * `--unreachable-interval-multiplier <n>`. Per-cause individual flags
 * deferred to v0.4+ if an operator surfaces the need.
 *
 * **Probe protocol:**
 *
 *   - GET to `serviceUrl` with bounded timeout (default 10s).
 *   - On 2xx/3xx/4xx → `state: ok` (probe-payload-rejection is expected
 *     for unauthenticated GET on x402 endpoints — they return 402).
 *   - On 5xx → retry once (10s delay). If 2nd attempt also 5xx → retry
 *     once more. If 3 consecutive 5xx → `persistent_5xx`.
 *   - On network error → classify via `classifyFetchError` against the
 *     underlying error code (`ENOTFOUND`, `ECONNREFUSED`, `CERT_*`,
 *     `EPROTO`, `AbortError`).
 *
 * **JSONL probe_attempt event:**
 *
 * Each probe (success or fail) emits one `bazaar.probe_attempt` record
 * appended to the `probeHistoryLog` JSONL file, if specified. Re-runs
 * of `bazaar-check --probe-history-log <file>` read prior records to
 * compute consensus. Preserves the local-first stateless property: no
 * external state directory; probe history lives in the same JSONL log
 * the user already manages.
 *
 * Cross-facet precedence (per `src/bazaar/diagnose-rules.md`):
 *
 *   `service_unreachable` > `upstream_stuck.cause` (K) >
 *   `upstream_issue` > `facilitator_fitness` facet (G) >
 *   `host_pollution` facet (L) > `looks_correct`.
 *
 * A DNS-failing service skips K/G/L's diagnosis because it never reached
 * the upstream surfaces those probe. The verdict synthesizer enforces
 * this precedence.
 */

import { appendFileSync } from "node:fs";
import type { Clock } from "./clock.js";
import { realClock } from "./clock.js";
import {
  consensusReached,
  DEFAULT_CONSENSUS_COUNT,
  DEFAULT_INTERVAL_MULTIPLIER,
  nextAttemptSeq,
  readProbeHistory,
} from "./probe-history.js";
import type {
  CheckResult,
  ProbeAttemptRecord,
  ReachabilityFacet,
  UnreachableCause,
} from "./types.js";

/** Default per-probe timeout (ms). Tunable in tests. */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/** Bounded retry count for 5xx classification (within ONE probe attempt). */
export const PERSISTENT_5XX_RETRY_COUNT = 3;

/** Inter-retry delay for 5xx (ms). */
export const PERSISTENT_5XX_RETRY_DELAY_MS = 500;

export type ReachabilityFetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface ReachabilityCheckOptions {
  readonly fetcher?: ReachabilityFetcher;
  readonly clock?: Clock;
  /** Per-probe HTTP timeout in ms. */
  readonly probeTimeoutMs?: number;
  /** Path to JSONL log to read prior probe history from + append current probe. */
  readonly probeHistoryLog?: string;
  /** Consensus threshold (consecutive matching probes). */
  readonly consensusCount?: number;
  /** Uniform multiplier over per-cause default windows. */
  readonly intervalMultiplier?: number;
  /** Test injection: override the default appendFileSync writer. */
  readonly logWriter?: (path: string, line: string) => void;
}

interface ProbeOutcome {
  /** `null` when state === "ok". */
  readonly cause: UnreachableCause | null;
  readonly latencyMs: number;
  readonly diagnostic: string;
}

/**
 * Classify a thrown fetch error into an `UnreachableCause`. Node's
 * undici-based fetch wraps the underlying error as `cause`. Inspects
 * common error codes + name to discriminate DNS / TCP / TLS / timeout.
 *
 * Returns `null` when the error doesn't match a known unreachability
 * shape — caller treats as a different failure class.
 */
export function classifyFetchError(err: unknown): UnreachableCause | null {
  if (err === null || typeof err !== "object") return null;
  const errObj = err as { name?: string; message?: string; cause?: unknown };

  // AbortError from our timeout
  if (errObj.name === "AbortError") return "timeout";

  // Walk the cause chain. undici wraps underlying errors as cause.
  const cause = errObj.cause as { code?: string; name?: string } | undefined;
  const code = typeof cause === "object" && cause !== null ? cause.code : undefined;
  const causeName = typeof cause === "object" && cause !== null ? cause.name : undefined;

  // DNS-class failures
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ESERVFAIL") {
    return "dns_failure";
  }

  // TCP-class refused / host-unreachable
  if (code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return "tcp_refused";
  }

  // TLS-class — cert / ALPN / protocol errors. undici surfaces these
  // with codes prefixed by `CERT_`, `ERR_TLS_`, `EPROTO`, or
  // `UNABLE_TO_VERIFY_*`. Some TLS handshake mid-failures surface as
  // ECONNRESET *during* the handshake; we conservatively classify
  // ECONNRESET as `tls_error` only when the message hints at TLS.
  if (
    typeof code === "string" &&
    (code.startsWith("CERT_") ||
      code.startsWith("ERR_TLS_") ||
      code === "EPROTO" ||
      code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
      code === "UNABLE_TO_GET_ISSUER_CERT" ||
      code === "DEPTH_ZERO_SELF_SIGNED_CERT")
  ) {
    return "tls_error";
  }
  if (
    code === "ECONNRESET" &&
    typeof errObj.message === "string" &&
    /tls|ssl|handshake/i.test(errObj.message)
  ) {
    return "tls_error";
  }

  // AbortError can also surface in the cause for some Node versions.
  if (causeName === "AbortError" || code === "UND_ERR_ABORTED") return "timeout";

  return null;
}

async function singleProbe(
  serviceUrl: string,
  fetcher: ReachabilityFetcher,
  timeoutMs: number,
  clock: Clock,
): Promise<{ response: Response; latencyMs: number } | { error: unknown; latencyMs: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = clock.now();
  try {
    const response = await fetcher(serviceUrl, { method: "GET", signal: controller.signal });
    return { response, latencyMs: clock.now() - start };
  } catch (error) {
    return { error, latencyMs: clock.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe the service URL once, with bounded retry on 5xx for
 * `persistent_5xx` classification. All other classifications happen
 * on the first attempt.
 */
async function probeReachability(
  serviceUrl: string,
  fetcher: ReachabilityFetcher,
  timeoutMs: number,
  clock: Clock,
): Promise<ProbeOutcome> {
  // First probe.
  const first = await singleProbe(serviceUrl, fetcher, timeoutMs, clock);
  if ("error" in first) {
    const cause = classifyFetchError(first.error);
    if (cause === null) {
      // Unknown error shape — conservative: treat as timeout-class
      // (most non-classified errors are some form of stall).
      return {
        cause: "timeout",
        latencyMs: first.latencyMs,
        diagnostic: `unclassified error: ${first.error instanceof Error ? first.error.message : String(first.error)}`,
      };
    }
    // Note: latency stays in latencyMs (and the bazaar.probe_attempt
    // JSONL event's latency_ms field). Excluded from the diagnostic
    // string so the JSON API snapshot stays deterministic across
    // CI runners with different wall-clock speeds. (Bug class found
    // by Node 20 vs Node 22 snapshot drift on `(0ms)` vs `(1ms)`.)
    return {
      cause,
      latencyMs: first.latencyMs,
      diagnostic: `${cause} on first probe attempt`,
    };
  }
  // We got a Response. Status-based classification.
  const status = first.response.status;
  if (status >= 200 && status < 500) {
    return {
      cause: null,
      latencyMs: first.latencyMs,
      diagnostic: `HTTP ${status} on first probe — service responsive`,
    };
  }
  // 5xx — enter the bounded retry loop for `persistent_5xx`.
  let last5xx = status;
  let totalLatency = first.latencyMs;
  for (let attempt = 1; attempt < PERSISTENT_5XX_RETRY_COUNT; attempt++) {
    await new Promise((r) => setTimeout(r, PERSISTENT_5XX_RETRY_DELAY_MS));
    const next = await singleProbe(serviceUrl, fetcher, timeoutMs, clock);
    if ("error" in next) {
      // Mid-loop error after initial 5xx — classify as the error, not
      // as persistent_5xx (the service was responsive then stopped).
      const cause = classifyFetchError(next.error) ?? "timeout";
      return {
        cause,
        latencyMs: totalLatency + next.latencyMs,
        diagnostic: `HTTP ${last5xx} then ${cause} on retry — mixed failure mode`,
      };
    }
    totalLatency += next.latencyMs;
    if (next.response.status < 500) {
      // Recovered — service is responsive (just had a transient 5xx).
      return {
        cause: null,
        latencyMs: totalLatency,
        diagnostic: `HTTP ${last5xx} then ${next.response.status} on retry — recovered (transient 5xx, not persistent)`,
      };
    }
    last5xx = next.response.status;
  }
  // All N attempts returned 5xx.
  return {
    cause: "persistent_5xx",
    latencyMs: totalLatency,
    diagnostic: `HTTP ${last5xx} consistently across ${PERSISTENT_5XX_RETRY_COUNT} attempts (server-malfunction signal, not unreachability)`,
  };
}

/**
 * Run the reachability check. Wires:
 *   - Single probe via `probeReachability`
 *   - Prior probe history read via `readProbeHistory`
 *   - Consensus check via `consensusReached`
 *   - New probe_attempt event appended to log (if specified)
 *
 * Returns a CheckResult with status:
 *   - `pass` when state === "ok"
 *   - `info` when state === "unreachable_first_probe" (single-probe
 *     failure; verdict synthesizer treats as upstream signal but does
 *     NOT promote to top-level `service_unreachable`)
 *   - `info` when state === "unreachable" (consensus met; verdict
 *     synthesizer promotes to top-level `service_unreachable`)
 *
 * The verdict synthesizer in `verdict.ts` reads the facet's
 * `consensus_met` field to decide between the two info states.
 */
export async function checkReachability(
  serviceUrl: string,
  opts: ReachabilityCheckOptions = {},
): Promise<CheckResult> {
  const fetcher = opts.fetcher ?? (fetch as ReachabilityFetcher);
  const clock = opts.clock ?? realClock;
  const timeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const consensusThreshold = opts.consensusCount ?? DEFAULT_CONSENSUS_COUNT;
  const intervalMultiplier = opts.intervalMultiplier ?? DEFAULT_INTERVAL_MULTIPLIER;

  const outcome = await probeReachability(serviceUrl, fetcher, timeoutMs, clock);

  // Build the current probe_attempt record.
  const priorHistory = readProbeHistory(opts.probeHistoryLog, serviceUrl);
  const current: ProbeAttemptRecord = {
    event: "bazaar.probe_attempt",
    t: clock.nowIso(),
    service_url: serviceUrl,
    attempt_seq: nextAttemptSeq(priorHistory),
    unreachable_cause: outcome.cause,
    latency_ms: outcome.latencyMs,
  };

  // Append to log if specified. Failure to write is non-fatal (we
  // still emit the facet); future runs just won't see this probe.
  if (opts.probeHistoryLog) {
    try {
      const writer = opts.logWriter ?? ((path: string, line: string) => appendFileSync(path, line));
      writer(opts.probeHistoryLog, JSON.stringify(current) + "\n");
    } catch {
      // swallow; log write failures don't block the check
    }
  }

  // If the probe succeeded, emit the pass facet.
  if (outcome.cause === null) {
    const facet: ReachabilityFacet = {
      state: "ok",
      probe_count: priorHistory.length + 1,
      consensus_threshold: consensusThreshold,
      consensus_met: false,
      diagnostic: outcome.diagnostic,
    };
    return {
      check: "reachability",
      status: "pass",
      message: `service responsive: ${outcome.diagnostic}`,
      detail: { reachability: facet },
    };
  }

  // Persistent_5xx is out-of-band — rolls up to upstream_issue via the
  // existing info-on-upstream-check path, never to service_unreachable
  // even with consensus.
  if (outcome.cause === "persistent_5xx") {
    const facet: ReachabilityFacet = {
      state: "unreachable_first_probe",
      unreachable_cause: "persistent_5xx",
      probe_count: 1,
      consensus_threshold: consensusThreshold,
      consensus_met: false,
      diagnostic: outcome.diagnostic,
    };
    return {
      check: "reachability",
      status: "info",
      message: `service returning persistent 5xx: ${outcome.diagnostic}`,
      fix: `the service responds but consistently returns 5xx — a server-malfunction signal, not unreachability. Check the service's logs / status page. This rolls up to upstream_issue (exit 3), NOT service_unreachable.`,
      detail: { reachability: facet },
    };
  }

  // Network-class failure — compute consensus.
  const history = [...priorHistory, current];
  const consensus = consensusReached({
    history,
    cause: outcome.cause,
    threshold: consensusThreshold,
    intervalMultiplier,
  });

  const facet: ReachabilityFacet = {
    state: consensus.met ? "unreachable" : "unreachable_first_probe",
    unreachable_cause: outcome.cause,
    probe_count: history.length,
    consensus_threshold: consensusThreshold,
    consensus_met: consensus.met,
    diagnostic: outcome.diagnostic,
    consensus_window_ms: consensus.windowMs,
  };

  if (consensus.met) {
    return {
      check: "reachability",
      status: "info",
      message: `service unreachable: ${consensus.consecutiveMatching} consecutive ${outcome.cause} probes within window`,
      fix: `${outcome.cause} consensus met across ${consensus.consecutiveMatching} probes. The service is not reachable at the network layer; bazaar-check verdicts for indexing / propagation / facilitator-fitness / host-pollution are moot until the service responds. Action depends on cause: dns_failure → check DNS records; tcp_refused → check that the server is listening on the expected port; tls_error → check cert expiration + ALPN config; timeout → check application-level responsiveness.`,
      detail: { reachability: facet },
    };
  }

  // Single-probe failure (consensus not met) — info but does NOT
  // promote to top-level service_unreachable per ADR-006. The verdict
  // synthesizer reads `consensus_met: false` and emits the facet under
  // existing implementation_issue / upstream_issue depending on what
  // else fails.
  return {
    check: "reachability",
    status: "info",
    message: `${outcome.cause} on first probe — consensus not yet established (${history.length}/${consensusThreshold} consecutive matching probes${opts.probeHistoryLog ? "" : "; no probe-history log supplied"})`,
    fix: `single-probe failure may be transient. Re-run \`bazaar-check\` with \`--probe-history-log <path>\` periodically (per-cause window: ${Math.round(consensus.windowMs / 60_000)}min for ${outcome.cause}) to confirm. ${consensusThreshold} consecutive matching probes promote this to top-level \`service_unreachable\`.`,
    detail: { reachability: facet },
  };
}
