/**
 * X402-21 v0.2 diagnose module — public surface.
 *
 * The `diagnose()` function is the heart: pure, deterministic,
 * dependency-free. CLI subcommands `validate` and `explain` are thin
 * adapters that build a `DiagnosticContext` from their respective
 * inputs (live RPC vs. captured JSONL) and render the resulting
 * `DiagnosticReport`.
 */
export { diagnose, ALL_RULES } from "./rules.js";
export { formatReportHuman, formatReportJson } from "./format.js";
export type {
  DiagnosticContext,
  DiagnosticResult,
  DiagnosticReport,
  DiagnosticRule,
  DiagnosticStatus,
  OverallStatus,
  WalletState,
} from "./types.js";
