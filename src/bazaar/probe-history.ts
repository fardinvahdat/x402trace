/**
 * X402-52 (v0.3.4 I, ADR-006) — JSONL probe-history reader + consensus computer.
 *
 * Reads prior `bazaar.probe_attempt` event records from a JSONL log,
 * filters to the service URL under probe, and computes whether the
 * cross-probe consensus threshold has been met for a specific
 * unreachable cause.
 *
 * The JSONL-as-state-store design (per ADR-006) keeps probe history
 * local to the user's existing `--log <file>` stream — no separate
 * cache directory, no migration friction, no rotation surprises
 * beyond what the user already manages for the JSONL log.
 *
 * Per-cause windows locked 2026-05-29 (TomSmart_ai endorsement):
 *
 *   | cause          | default interval | rationale                              |
 *   |----------------|------------------|----------------------------------------|
 *   | dns_failure    | 5 min            | DNS TTLs fast; NXDOMAIN cleanest       |
 *   | tcp_refused    | 15 min           | LB reaping / deploy churn              |
 *   | tls_error      | 30 min           | TLS-1.3/ALPN / cert rotation           |
 *   | timeout        | 15 min           | Same transient class as tcp_refused    |
 *   | persistent_5xx | n/a              | Out-of-band — within single probe loop |
 *
 * Operators can scale all windows uniformly via
 * `--unreachable-interval-multiplier <n>`.
 */

import { readFileSync, existsSync } from "node:fs";
import type { ProbeAttemptRecord, UnreachableCause } from "./types.js";

/**
 * Per-cause default consensus windows in milliseconds. Locked design
 * per ADR-006 + impl-notes; TomSmart endorsement quoted in X402-52
 * Jira comment 10110.
 */
export const PER_CAUSE_INTERVAL_MS: Readonly<Record<UnreachableCause, number>> = {
  dns_failure: 5 * 60 * 1000,
  tcp_refused: 15 * 60 * 1000,
  tls_error: 30 * 60 * 1000,
  timeout: 15 * 60 * 1000,
  // `persistent_5xx` is out-of-band — handled in-probe-retry-loop, not
  // cross-probe. Zero placeholder; consensusReached never consults it.
  persistent_5xx: 0,
};

export const DEFAULT_CONSENSUS_COUNT = 3;
export const DEFAULT_INTERVAL_MULTIPLIER = 1;

/**
 * Parse a JSONL log file and return the contained
 * `bazaar.probe_attempt` records filtered to the given service URL.
 * Returns records sorted oldest-first by `t`.
 *
 * Robust to:
 *   - Missing file (returns [])
 *   - Lines that aren't valid JSON (skipped silently — JSONL logs can
 *     interleave non-probe records or non-event lines)
 *   - Records missing required fields (skipped)
 *   - Records for different service URLs (filtered out)
 */
export function readProbeHistory(
  logPath: string | undefined,
  serviceUrl: string,
): ProbeAttemptRecord[] {
  if (!logPath || !existsSync(logPath)) return [];
  const text = readFileSync(logPath, "utf8");
  const records: ProbeAttemptRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isProbeAttemptRecord(parsed)) continue;
    if (parsed.service_url !== serviceUrl) continue;
    records.push(parsed);
  }
  records.sort((a, b) => a.t.localeCompare(b.t));
  return records;
}

function isProbeAttemptRecord(value: unknown): value is ProbeAttemptRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["event"] === "bazaar.probe_attempt" &&
    typeof v["t"] === "string" &&
    typeof v["service_url"] === "string" &&
    typeof v["attempt_seq"] === "number" &&
    (v["unreachable_cause"] === null || typeof v["unreachable_cause"] === "string") &&
    typeof v["latency_ms"] === "number"
  );
}

export interface ConsensusInput {
  /** Prior records from log, plus the current probe appended last. */
  readonly history: readonly ProbeAttemptRecord[];
  /** Cause to check for consensus on. */
  readonly cause: UnreachableCause;
  /** Required consecutive matching probes (≥1). */
  readonly threshold: number;
  /** Uniform scalar over the per-cause window table (default 1). */
  readonly intervalMultiplier?: number;
  /** Optional override of the per-cause default window (used by tests). */
  readonly windowMsOverride?: number;
}

export interface ConsensusResult {
  readonly met: boolean;
  /** Effective window applied (post-multiplier). */
  readonly windowMs: number;
  /** Number of consecutive matching probes counted toward consensus. */
  readonly consecutiveMatching: number;
}

/**
 * Compute whether the last N probes in `history` all share the same
 * `cause` and span ≤ `threshold * windowMs * 2` (generous bound —
 * protects against probes 10 days apart counting as "consecutive").
 *
 * Per-cause window comes from PER_CAUSE_INTERVAL_MS scaled by
 * `intervalMultiplier`. `persistent_5xx` is never a consensus cause
 * (out-of-band signal); consensusReached returns `met: false` for it.
 */
export function consensusReached(opts: ConsensusInput): ConsensusResult {
  const multiplier = opts.intervalMultiplier ?? DEFAULT_INTERVAL_MULTIPLIER;
  const windowMs = opts.windowMsOverride ?? PER_CAUSE_INTERVAL_MS[opts.cause] * multiplier;

  // persistent_5xx never reaches cross-probe consensus.
  if (opts.cause === "persistent_5xx") {
    return { met: false, windowMs, consecutiveMatching: 0 };
  }
  if (opts.threshold <= 0) {
    return { met: false, windowMs, consecutiveMatching: 0 };
  }
  if (opts.history.length < opts.threshold) {
    return {
      met: false,
      windowMs,
      consecutiveMatching: opts.history.filter((r) => r.unreachable_cause === opts.cause).length,
    };
  }
  // Walk from the most recent probe backwards; count consecutive
  // matches with the same cause.
  const recent = opts.history.slice(-opts.threshold);
  for (const r of recent) {
    if (r.unreachable_cause !== opts.cause) {
      return { met: false, windowMs, consecutiveMatching: 0 };
    }
  }
  // Time-span sanity check: the oldest of the N matching probes must
  // not be impossibly far from the newest. Use a generous bound of
  // `threshold * windowMs * 2` — this catches "probes 10 days apart
  // somehow counting as consecutive" while allowing for legitimate
  // operator variance in re-probe timing.
  const oldest = Date.parse(recent[0]!.t);
  const newest = Date.parse(recent[recent.length - 1]!.t);
  if (Number.isFinite(oldest) && Number.isFinite(newest)) {
    const span = newest - oldest;
    if (span > opts.threshold * windowMs * 2) {
      return { met: false, windowMs, consecutiveMatching: opts.threshold };
    }
  }
  return { met: true, windowMs, consecutiveMatching: opts.threshold };
}

/**
 * Return the next attempt_seq for a (service_url, log) pair. Used by
 * the reachability check to label a fresh probe before writing it back
 * to the JSONL log.
 */
export function nextAttemptSeq(history: readonly ProbeAttemptRecord[]): number {
  if (history.length === 0) return 1;
  const maxSeq = Math.max(...history.map((r) => r.attempt_seq));
  return maxSeq + 1;
}
