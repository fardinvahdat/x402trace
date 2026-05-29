/**
 * X402-52 (v0.3.4 I, ADR-006) — reachability + probe-history + clock tests.
 *
 * Covers:
 *   - `classifyFetchError` discrimination (DNS / TCP / TLS / timeout / abort)
 *   - `checkReachability` happy path (HTTP 200 / 402 / 404)
 *   - `checkReachability` per-cause unreachability classification
 *   - `checkReachability` persistent_5xx detection (bounded retry loop)
 *   - `checkReachability` single-probe mode (no log) → never fires top-level
 *   - `checkReachability` consensus-met mode (log with prior matching probes) → fires unreachable state
 *   - `readProbeHistory` JSONL parsing + filtering + sorting
 *   - `consensusReached` threshold + per-cause window + persistent_5xx out-of-band
 *   - `Clock` mock advance/setEpoch
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockClock } from "../../src/bazaar/clock.js";
import {
  consensusReached,
  PER_CAUSE_INTERVAL_MS,
  nextAttemptSeq,
  readProbeHistory,
} from "../../src/bazaar/probe-history.js";
import { checkReachability, classifyFetchError } from "../../src/bazaar/reachability.js";
import type { ProbeAttemptRecord, ReachabilityFacet } from "../../src/bazaar/types.js";

const SERVICE = "https://api.example.com/x402";

function tmpJsonl(): string {
  const dir = mkdtempSync(join(tmpdir(), "x402trace-probe-history-"));
  return join(dir, "probe.jsonl");
}

describe("Clock", () => {
  it("mock clock advances by ms", () => {
    const c = createMockClock(1_000);
    expect(c.now()).toBe(1_000);
    c.advance(5_000);
    expect(c.now()).toBe(6_000);
    expect(c.nowIso()).toBe(new Date(6_000).toISOString());
  });

  it("mock clock setEpoch jumps", () => {
    const c = createMockClock();
    c.setEpoch(2_000_000_000_000);
    expect(c.now()).toBe(2_000_000_000_000);
  });
});

describe("classifyFetchError", () => {
  it("classifies AbortError as timeout", () => {
    const err = new Error("aborted");
    (err as Error & { name: string }).name = "AbortError";
    expect(classifyFetchError(err)).toBe("timeout");
  });

  it("classifies ENOTFOUND as dns_failure (via cause)", () => {
    const err = Object.assign(new Error("fetch failed"), {
      cause: { code: "ENOTFOUND" },
    });
    expect(classifyFetchError(err)).toBe("dns_failure");
  });

  it("classifies EAI_AGAIN as dns_failure", () => {
    const err = Object.assign(new Error("fetch failed"), { cause: { code: "EAI_AGAIN" } });
    expect(classifyFetchError(err)).toBe("dns_failure");
  });

  it("classifies ECONNREFUSED as tcp_refused", () => {
    const err = Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    expect(classifyFetchError(err)).toBe("tcp_refused");
  });

  it("classifies EHOSTUNREACH as tcp_refused", () => {
    const err = Object.assign(new Error("fetch failed"), { cause: { code: "EHOSTUNREACH" } });
    expect(classifyFetchError(err)).toBe("tcp_refused");
  });

  it("classifies CERT_HAS_EXPIRED as tls_error", () => {
    const err = Object.assign(new Error("fetch failed"), {
      cause: { code: "CERT_HAS_EXPIRED" },
    });
    expect(classifyFetchError(err)).toBe("tls_error");
  });

  it("classifies UNABLE_TO_VERIFY_LEAF_SIGNATURE as tls_error", () => {
    const err = Object.assign(new Error("fetch failed"), {
      cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" },
    });
    expect(classifyFetchError(err)).toBe("tls_error");
  });

  it("classifies EPROTO as tls_error", () => {
    const err = Object.assign(new Error("fetch failed"), { cause: { code: "EPROTO" } });
    expect(classifyFetchError(err)).toBe("tls_error");
  });

  it("classifies ECONNRESET with TLS message as tls_error", () => {
    const err = Object.assign(new Error("TLS handshake failed: ECONNRESET"), {
      cause: { code: "ECONNRESET" },
    });
    expect(classifyFetchError(err)).toBe("tls_error");
  });

  it("returns null for non-error inputs", () => {
    expect(classifyFetchError("not an error")).toBeNull();
    expect(classifyFetchError(null)).toBeNull();
    expect(classifyFetchError(42)).toBeNull();
  });

  it("returns null for errors without recognised codes", () => {
    expect(classifyFetchError(new Error("some unrelated thing"))).toBeNull();
  });
});

describe("readProbeHistory", () => {
  it("returns [] when log file does not exist", () => {
    expect(readProbeHistory("/nonexistent/path.jsonl", SERVICE)).toEqual([]);
  });

  it("returns [] when probeHistoryLog is undefined", () => {
    expect(readProbeHistory(undefined, SERVICE)).toEqual([]);
  });

  it("parses + filters + sorts probe_attempt records", () => {
    const path = tmpJsonl();
    const records: ProbeAttemptRecord[] = [
      {
        event: "bazaar.probe_attempt",
        t: "2026-05-30T12:00:00.000Z",
        service_url: SERVICE,
        attempt_seq: 2,
        unreachable_cause: "dns_failure",
        latency_ms: 50,
      },
      {
        event: "bazaar.probe_attempt",
        t: "2026-05-30T11:00:00.000Z",
        service_url: SERVICE,
        attempt_seq: 1,
        unreachable_cause: "dns_failure",
        latency_ms: 45,
      },
      {
        event: "bazaar.probe_attempt",
        t: "2026-05-30T13:00:00.000Z",
        service_url: "https://other.example.com",
        attempt_seq: 1,
        unreachable_cause: "tcp_refused",
        latency_ms: 100,
      },
    ];
    writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const got = readProbeHistory(path, SERVICE);
    expect(got).toHaveLength(2);
    expect(got[0]!.attempt_seq).toBe(1); // sorted ascending by t
    expect(got[1]!.attempt_seq).toBe(2);
  });

  it("tolerates non-JSON lines, non-probe events, and malformed records", () => {
    const path = tmpJsonl();
    writeFileSync(
      path,
      [
        "not json",
        JSON.stringify({ event: "exchange.payment", t: "2026-05-30T10:00:00.000Z" }),
        JSON.stringify({ event: "bazaar.probe_attempt" }), // missing required fields
        JSON.stringify({
          event: "bazaar.probe_attempt",
          t: "2026-05-30T11:00:00.000Z",
          service_url: SERVICE,
          attempt_seq: 1,
          unreachable_cause: "dns_failure",
          latency_ms: 50,
        }),
        "",
      ].join("\n"),
    );
    const got = readProbeHistory(path, SERVICE);
    expect(got).toHaveLength(1);
  });
});

describe("consensusReached", () => {
  function probe(
    seq: number,
    cause: ProbeAttemptRecord["unreachable_cause"],
    tIso: string,
  ): ProbeAttemptRecord {
    return {
      event: "bazaar.probe_attempt",
      t: tIso,
      service_url: SERVICE,
      attempt_seq: seq,
      unreachable_cause: cause,
      latency_ms: 50,
    };
  }

  it("returns met=false when history is shorter than threshold", () => {
    const r = consensusReached({
      history: [probe(1, "dns_failure", "2026-05-30T12:00:00.000Z")],
      cause: "dns_failure",
      threshold: 3,
    });
    expect(r.met).toBe(false);
  });

  it("returns met=true when last N probes all match the same cause", () => {
    const r = consensusReached({
      history: [
        probe(1, "dns_failure", "2026-05-30T12:00:00.000Z"),
        probe(2, "dns_failure", "2026-05-30T12:05:00.000Z"),
        probe(3, "dns_failure", "2026-05-30T12:10:00.000Z"),
      ],
      cause: "dns_failure",
      threshold: 3,
    });
    expect(r.met).toBe(true);
    expect(r.consecutiveMatching).toBe(3);
  });

  it("returns met=false when one probe in the window has a different cause", () => {
    const r = consensusReached({
      history: [
        probe(1, "dns_failure", "2026-05-30T12:00:00.000Z"),
        probe(2, "tcp_refused", "2026-05-30T12:05:00.000Z"), // breaks consensus
        probe(3, "dns_failure", "2026-05-30T12:10:00.000Z"),
      ],
      cause: "dns_failure",
      threshold: 3,
    });
    expect(r.met).toBe(false);
  });

  it("returns met=false when probe span exceeds 2 * threshold * windowMs (stale history)", () => {
    const r = consensusReached({
      history: [
        probe(1, "dns_failure", "2026-04-01T00:00:00.000Z"), // 60 days old
        probe(2, "dns_failure", "2026-04-15T00:00:00.000Z"),
        probe(3, "dns_failure", "2026-05-30T12:00:00.000Z"),
      ],
      cause: "dns_failure",
      threshold: 3,
    });
    expect(r.met).toBe(false);
  });

  it("uses dns_failure default window (5 min)", () => {
    const r = consensusReached({
      history: [
        probe(1, "dns_failure", "2026-05-30T12:00:00.000Z"),
        probe(2, "dns_failure", "2026-05-30T12:05:00.000Z"),
        probe(3, "dns_failure", "2026-05-30T12:10:00.000Z"),
      ],
      cause: "dns_failure",
      threshold: 3,
    });
    expect(r.windowMs).toBe(PER_CAUSE_INTERVAL_MS.dns_failure);
  });

  it("scales window by intervalMultiplier", () => {
    const r = consensusReached({
      history: [],
      cause: "dns_failure",
      threshold: 3,
      intervalMultiplier: 2,
    });
    expect(r.windowMs).toBe(PER_CAUSE_INTERVAL_MS.dns_failure * 2);
  });

  it("persistent_5xx is OUT-OF-BAND — never returns met=true", () => {
    const r = consensusReached({
      history: [
        probe(1, "persistent_5xx", "2026-05-30T12:00:00.000Z"),
        probe(2, "persistent_5xx", "2026-05-30T12:05:00.000Z"),
        probe(3, "persistent_5xx", "2026-05-30T12:10:00.000Z"),
      ],
      cause: "persistent_5xx",
      threshold: 3,
    });
    expect(r.met).toBe(false);
  });

  it("threshold of 0 returns false", () => {
    const r = consensusReached({
      history: [],
      cause: "dns_failure",
      threshold: 0,
    });
    expect(r.met).toBe(false);
  });
});

describe("nextAttemptSeq", () => {
  it("returns 1 for empty history", () => {
    expect(nextAttemptSeq([])).toBe(1);
  });

  it("returns max(attempt_seq) + 1", () => {
    const history: ProbeAttemptRecord[] = [
      {
        event: "bazaar.probe_attempt",
        t: "x",
        service_url: SERVICE,
        attempt_seq: 3,
        unreachable_cause: null,
        latency_ms: 0,
      },
      {
        event: "bazaar.probe_attempt",
        t: "x",
        service_url: SERVICE,
        attempt_seq: 1,
        unreachable_cause: null,
        latency_ms: 0,
      },
      {
        event: "bazaar.probe_attempt",
        t: "x",
        service_url: SERVICE,
        attempt_seq: 2,
        unreachable_cause: null,
        latency_ms: 0,
      },
    ];
    expect(nextAttemptSeq(history)).toBe(4);
  });
});

describe("checkReachability — happy path", () => {
  it("returns state: ok when service returns 200", async () => {
    const fetcher = (() => Promise.resolve(new Response("{}", { status: 200 }))) as typeof fetch;
    const result = await checkReachability(SERVICE, {
      fetcher,
      clock: createMockClock(),
    });
    expect(result.status).toBe("pass");
    const facet = result.detail?.["reachability"] as ReachabilityFacet;
    expect(facet.state).toBe("ok");
    expect(facet.unreachable_cause).toBeUndefined();
  });

  it("returns state: ok when service returns 402 (x402 challenge — expected)", async () => {
    const fetcher = (() => Promise.resolve(new Response("{}", { status: 402 }))) as typeof fetch;
    const result = await checkReachability(SERVICE, {
      fetcher,
      clock: createMockClock(),
    });
    const facet = result.detail?.["reachability"] as ReachabilityFacet;
    expect(facet.state).toBe("ok");
  });

  it("returns state: ok when service returns 404 (responsive, just wrong path)", async () => {
    const fetcher = (() => Promise.resolve(new Response("", { status: 404 }))) as typeof fetch;
    const result = await checkReachability(SERVICE, {
      fetcher,
      clock: createMockClock(),
    });
    const facet = result.detail?.["reachability"] as ReachabilityFacet;
    expect(facet.state).toBe("ok");
  });
});

describe("checkReachability — unreachable_first_probe (no log)", () => {
  it("classifies ENOTFOUND as dns_failure with state=unreachable_first_probe", async () => {
    const err = Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
    const fetcher = (() => Promise.reject(err)) as typeof fetch;
    const result = await checkReachability(SERVICE, {
      fetcher,
      clock: createMockClock(),
    });
    expect(result.status).toBe("info");
    const facet = result.detail?.["reachability"] as ReachabilityFacet;
    expect(facet.state).toBe("unreachable_first_probe");
    expect(facet.unreachable_cause).toBe("dns_failure");
    expect(facet.consensus_met).toBe(false);
    // INFO note about supplying --probe-history-log
    expect(result.fix).toContain("probe-history-log");
  });

  it("classifies ECONNREFUSED as tcp_refused", async () => {
    const err = Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const fetcher = (() => Promise.reject(err)) as typeof fetch;
    const result = await checkReachability(SERVICE, {
      fetcher,
      clock: createMockClock(),
    });
    const facet = result.detail?.["reachability"] as ReachabilityFacet;
    expect(facet.unreachable_cause).toBe("tcp_refused");
  });
});

describe("checkReachability — persistent_5xx (out-of-band, within single probe)", () => {
  it("classifies 3 consecutive 5xx within ONE probe attempt as persistent_5xx", async () => {
    let call = 0;
    const fetcher = (() => {
      call++;
      return Promise.resolve(new Response("err", { status: 503 }));
    }) as typeof fetch;
    const result = await checkReachability(SERVICE, {
      fetcher,
      clock: createMockClock(),
    });
    expect(result.status).toBe("info");
    const facet = result.detail?.["reachability"] as ReachabilityFacet;
    expect(facet.unreachable_cause).toBe("persistent_5xx");
    // Should have called fetcher exactly 3 times (PERSISTENT_5XX_RETRY_COUNT)
    expect(call).toBe(3);
  });

  it("recovers from transient 5xx (one 503 followed by 200) → state=ok", async () => {
    let call = 0;
    const fetcher = (() => {
      call++;
      if (call === 1) return Promise.resolve(new Response("err", { status: 503 }));
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch;
    const result = await checkReachability(SERVICE, {
      fetcher,
      clock: createMockClock(),
    });
    const facet = result.detail?.["reachability"] as ReachabilityFacet;
    expect(facet.state).toBe("ok");
    expect(facet.unreachable_cause).toBeUndefined();
  });
});

describe("checkReachability — consensus-met (with probe history)", () => {
  it("promotes to state=unreachable when prior history + current probe = N consecutive matching", async () => {
    const path = tmpJsonl();
    // Pre-seed 2 prior dns_failure probes (within the 5min window)
    const priorRecords: ProbeAttemptRecord[] = [
      {
        event: "bazaar.probe_attempt",
        t: "2026-05-30T12:00:00.000Z",
        service_url: SERVICE,
        attempt_seq: 1,
        unreachable_cause: "dns_failure",
        latency_ms: 50,
      },
      {
        event: "bazaar.probe_attempt",
        t: "2026-05-30T12:05:00.000Z",
        service_url: SERVICE,
        attempt_seq: 2,
        unreachable_cause: "dns_failure",
        latency_ms: 50,
      },
    ];
    writeFileSync(path, priorRecords.map((r) => JSON.stringify(r)).join("\n") + "\n");

    // Mock clock to a time within the window of the prior probes
    const clock = createMockClock(Date.parse("2026-05-30T12:10:00.000Z"));
    const err = Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
    const fetcher = (() => Promise.reject(err)) as typeof fetch;

    const result = await checkReachability(SERVICE, {
      fetcher,
      clock,
      probeHistoryLog: path,
    });

    expect(result.status).toBe("info");
    const facet = result.detail?.["reachability"] as ReachabilityFacet;
    expect(facet.state).toBe("unreachable");
    expect(facet.consensus_met).toBe(true);
    expect(facet.unreachable_cause).toBe("dns_failure");
    expect(facet.probe_count).toBe(3); // 2 prior + 1 current

    // Log file should now contain the appended current probe
    const updatedLog = readFileSync(path, "utf8").trim().split("\n");
    expect(updatedLog).toHaveLength(3);
    const lastRecord = JSON.parse(updatedLog[updatedLog.length - 1]!);
    expect(lastRecord.event).toBe("bazaar.probe_attempt");
    expect(lastRecord.attempt_seq).toBe(3);
    expect(lastRecord.unreachable_cause).toBe("dns_failure");
  });

  it("does NOT promote when prior history is too old (stale window)", async () => {
    const path = tmpJsonl();
    const priorRecords: ProbeAttemptRecord[] = [
      {
        event: "bazaar.probe_attempt",
        t: "2026-04-01T00:00:00.000Z", // way outside 5min window
        service_url: SERVICE,
        attempt_seq: 1,
        unreachable_cause: "dns_failure",
        latency_ms: 50,
      },
      {
        event: "bazaar.probe_attempt",
        t: "2026-04-15T00:00:00.000Z",
        service_url: SERVICE,
        attempt_seq: 2,
        unreachable_cause: "dns_failure",
        latency_ms: 50,
      },
    ];
    writeFileSync(path, priorRecords.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const clock = createMockClock(Date.parse("2026-05-30T12:00:00.000Z"));
    const err = Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
    const fetcher = (() => Promise.reject(err)) as typeof fetch;

    const result = await checkReachability(SERVICE, {
      fetcher,
      clock,
      probeHistoryLog: path,
    });
    const facet = result.detail?.["reachability"] as ReachabilityFacet;
    expect(facet.state).toBe("unreachable_first_probe");
    expect(facet.consensus_met).toBe(false);
  });
});

describe("checkReachability — log write swallows errors", () => {
  it("does not throw when log writer fails", async () => {
    const fetcher = (() => Promise.resolve(new Response("{}", { status: 200 }))) as typeof fetch;
    const failingWriter = () => {
      throw new Error("disk full");
    };
    // Should NOT throw
    const result = await checkReachability(SERVICE, {
      fetcher,
      clock: createMockClock(),
      probeHistoryLog: "/somewhere",
      logWriter: failingWriter,
    });
    expect(result.status).toBe("pass");
  });
});
