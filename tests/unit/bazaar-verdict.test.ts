/**
 * X402-32 unit tests — verdict synthesizer.
 */
import { describe, expect, it } from "vitest";
import { synthesiseVerdict } from "../../src/bazaar/verdict.js";
import type { CheckResult } from "../../src/bazaar/types.js";

function r(check: string, status: CheckResult["status"]): CheckResult {
  return { check, status, message: `${check} ${status}` };
}

describe("synthesiseVerdict", () => {
  it("returns looks_correct (exit 0) when all checks pass", () => {
    const v = synthesiseVerdict([
      r("well-known", "pass"),
      r("challenge", "pass"),
      r("self-payment", "pass"),
      r("indexing", "pass"),
    ]);
    expect(v.kind).toBe("looks_correct");
    expect(v.exitCode).toBe(0);
  });

  it("returns implementation_issue (exit 2) when an implementation check fails", () => {
    const v = synthesiseVerdict([
      r("well-known", "fail"),
      r("challenge", "pass"),
      r("self-payment", "pass"),
      r("indexing", "pass"),
    ]);
    expect(v.kind).toBe("implementation_issue");
    expect(v.exitCode).toBe(2);
    if (v.kind === "implementation_issue") {
      expect(v.failedChecks).toEqual(["well-known"]);
    }
  });

  it("returns implementation_issue (exit 2) when self-payment fails", () => {
    const v = synthesiseVerdict([
      r("well-known", "pass"),
      r("challenge", "pass"),
      r("self-payment", "fail"),
      r("indexing", "pass"),
    ]);
    expect(v.kind).toBe("implementation_issue");
    if (v.kind === "implementation_issue") {
      expect(v.failedChecks).toEqual(["self-payment"]);
    }
  });

  it("aggregates multiple implementation fails in failedChecks", () => {
    const v = synthesiseVerdict([
      r("well-known", "fail"),
      r("challenge", "fail"),
      r("self-payment", "pass"),
      r("indexing", "pass"),
    ]);
    if (v.kind === "implementation_issue") {
      expect(v.failedChecks).toEqual(["well-known", "challenge"]);
    } else {
      throw new Error("expected implementation_issue");
    }
  });

  it("returns upstream_issue (exit 3) when only indexing surfaces an info signal", () => {
    const v = synthesiseVerdict([
      r("well-known", "pass"),
      r("challenge", "pass"),
      r("self-payment", "pass"),
      r("indexing", "info"),
    ]);
    expect(v.kind).toBe("upstream_issue");
    expect(v.exitCode).toBe(3);
    if (v.kind === "upstream_issue") {
      expect(v.upstreamChecks).toEqual(["indexing"]);
      expect(v.message).toMatch(/#2207/);
    }
  });

  it("prefers implementation_issue over upstream_issue when both signals are present", () => {
    const v = synthesiseVerdict([
      r("well-known", "fail"),
      r("challenge", "pass"),
      r("self-payment", "pass"),
      r("indexing", "info"),
    ]);
    expect(v.kind).toBe("implementation_issue");
  });

  it("treats 'info' on implementation checks as pass (not blocking the verdict)", () => {
    // info on a non-upstream check is unusual but defined as non-blocking.
    const v = synthesiseVerdict([
      r("well-known", "info"),
      r("challenge", "pass"),
      r("self-payment", "pass"),
      r("indexing", "pass"),
    ]);
    expect(v.kind).toBe("looks_correct");
  });
});
