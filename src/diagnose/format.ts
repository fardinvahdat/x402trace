/**
 * X402-21 v0.2 diagnose formatters.
 *
 * The diagnose engine is pure; renderers live here so the engine
 * stays testable without ANSI strings. `format-result.ts` in the CLI
 * layer uses the same colour-aware helpers — we mirror that style so
 * `validate` / `explain` output looks of-a-piece with `proxy` /
 * `inspect`.
 */

import type { Colorizer } from "../cli/color.js";
import type { DiagnosticReport, DiagnosticResult, OverallStatus } from "./types.js";

const STATUS_MARKERS = {
  pass: "✓",
  fail: "✗",
  skip: "·",
} as const;

const STATUS_COLOURS = {
  pass: "green" as const,
  fail: "red" as const,
  skip: "dim" as const,
};

const OVERALL_HEADLINE = {
  "would-succeed": "✓ would succeed",
  "would-fail": "✗ would fail",
  uncertain: "⚠ uncertain (key checks skipped)",
} as const;

const OVERALL_COLOURS = {
  "would-succeed": "green" as const,
  "would-fail": "red" as const,
  uncertain: "yellow" as const,
};

/**
 * Human-readable report. One headline + one line per rule. The
 * "fix" line for failures is indented under the rule it belongs to.
 */
export function formatReportHuman(report: DiagnosticReport, color: Colorizer): string {
  const headline = color.paint(
    OVERALL_COLOURS[report.overallStatus],
    `${OVERALL_HEADLINE[report.overallStatus]}`,
  );
  const lines = [color.paint("bold", `diagnose: ${headline}`), ""];
  for (const r of report.results) {
    lines.push(
      `  ${color.paint(STATUS_COLOURS[r.status], STATUS_MARKERS[r.status])} ${color.paint("bold", r.rule)}: ${r.message}`,
    );
    if (r.status === "fail" && r.fix) {
      lines.push(`    ${color.paint("dim", "fix:")} ${r.fix}`);
    }
  }
  return lines.join("\n");
}

/**
 * Machine-readable report. One JSON object per line plus a final
 * summary line, all newline-delimited so the output is grep- and
 * `jq`-friendly. Matches the JSONL ergonomics of `proxy --log json`.
 */
export function formatReportJson(report: DiagnosticReport): string {
  const lines: string[] = [];
  for (const r of report.results) {
    lines.push(JSON.stringify({ event: "diagnose.result", ...r }));
  }
  lines.push(
    JSON.stringify({
      event: "diagnose.summary",
      overallStatus: report.overallStatus,
      counts: countByStatus(report.results),
    }),
  );
  return lines.join("\n");
}

function countByStatus(results: readonly DiagnosticResult[]): {
  pass: number;
  fail: number;
  skip: number;
} {
  return {
    pass: results.filter((r) => r.status === "pass").length,
    fail: results.filter((r) => r.status === "fail").length,
    skip: results.filter((r) => r.status === "skip").length,
  };
}

// Re-export so call sites have a one-stop import.
export type { OverallStatus };
