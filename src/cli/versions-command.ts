/**
 * X402-36 — `x402trace versions <service-url>` SDK skew audit.
 *
 * Pure additive subcommand. Reads:
 *   - the user's local `package.json` (walking up from cwd) for any
 *     `@x402/*` or `x402-*` dependency versions
 *   - the service URL's 402 challenge for advertised version hints
 *     (`x402Version`, `Server` header, optional fields)
 *
 * Compares both against `known-skew.json` (committed alongside this
 * file). Prints a per-entry compatibility matrix. Exits 0 if no
 * known-skew matches; exits 2 if any match (warning or blocking).
 *
 * **Note on exit codes**: the original Jira AC proposed `1` for
 * warning-level skew, but `1` is `EXIT_USAGE` repo-wide. To stay
 * consistent we use `0` (no skew) / `2` (any skew); the warning-vs-
 * blocking distinction lives in the per-row output, not the exit code.
 */

import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseChallengeBody } from "../decoder/parse.js";
import type { LogFormat } from "../decoder/types.js";
import { createColorizer, type Colorizer } from "./color.js";
import { EXIT_RUNTIME, EXIT_SUCCESS, EXIT_USAGE, type ExitCode } from "./exit-codes.js";
import { BUNDLED_KNOWN_SKEW } from "./known-skew-data.js";

export interface VersionsCommandOptions {
  readonly service?: string;
  readonly log?: LogFormat;
  /**
   * Override the cwd from which package.json walks up. Tests inject
   * a fixture root.
   */
  readonly cwd?: string;
  /**
   * Override the bundled known-skew dataset. Tests inject scenarios
   * without depending on production data.
   */
  readonly knownSkew?: KnownSkewDataset;
}

export interface VersionsRunContext {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly color?: Colorizer;
  readonly fetch?: typeof fetch;
}

export type Severity = "warning" | "blocking";

export interface KnownSkewEntry {
  readonly id: string;
  readonly package: string;
  /** "any" matches the package regardless of version; "exact" requires version equality. */
  readonly match: "any" | "exact";
  readonly version?: string;
  readonly severity: Severity;
  readonly summary: string;
  readonly fix: string;
  readonly evidence?: string;
}

export interface KnownSkewDataset {
  readonly version: number;
  readonly entries: readonly KnownSkewEntry[];
}

export interface SkewMatch {
  readonly entry: KnownSkewEntry;
  readonly localVersion: string | "(absent)";
}

export interface VersionsReport {
  readonly service: string;
  readonly localPackageJsonPath: string | null;
  readonly localVersions: Readonly<Record<string, string>>;
  readonly serviceVersionHints: Readonly<Record<string, unknown>>;
  readonly matches: readonly SkewMatch[];
  readonly verdict: "no_known_skew" | "skew_detected";
}

function loadBundledKnownSkew(): KnownSkewDataset {
  return BUNDLED_KNOWN_SKEW;
}

/**
 * Walk up from `start` directory looking for a `package.json`. Returns
 * the absolute path on first hit, or null if we reach the root.
 */
export async function findPackageJson(start: string): Promise<string | null> {
  let current = resolve(start);
  // 10 levels max to avoid pathological symlink loops in tests.
  for (let i = 0; i < 10; i++) {
    const candidate = join(current, "package.json");
    try {
      const s = await stat(candidate);
      if (s.isFile()) return candidate;
    } catch {
      // continue
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/**
 * Extract x402-related dependency versions from a package.json's
 * `dependencies` and `devDependencies` maps. Filters to entries whose
 * name starts with `@x402/` or `x402-` (both naming conventions seen
 * in the ecosystem) or equals `x402` (the core package).
 */
export function extractX402Versions(packageJson: unknown): Record<string, string> {
  if (typeof packageJson !== "object" || packageJson === null) return {};
  const obj = packageJson as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of ["dependencies", "devDependencies"] as const) {
    const map = obj[key];
    if (typeof map !== "object" || map === null) continue;
    for (const [name, version] of Object.entries(map as Record<string, unknown>)) {
      if (typeof version !== "string") continue;
      if (name === "x402" || name.startsWith("@x402/") || name.startsWith("x402-")) {
        out[name] = version;
      }
    }
  }
  return out;
}

/** Match a local version string against a known-skew entry. */
function matchesEntry(entry: KnownSkewEntry, localVersion: string | undefined): boolean {
  if (entry.match === "any") return localVersion !== undefined;
  if (entry.match === "exact") {
    if (localVersion === undefined) return false;
    // Strip semver range prefix (^, ~, =) for the equality check.
    const normalised = localVersion.replace(/^[\^~=]/, "").trim();
    return normalised === entry.version;
  }
  return false;
}

export interface RunVersionsArgs {
  readonly service: string;
  readonly cwd: string;
  readonly fetcher: typeof fetch;
  readonly knownSkew: KnownSkewDataset;
}

/**
 * Pure-function core: given everything needed (service URL, cwd, fetch,
 * known-skew), produce a `VersionsReport`. The CLI command is a thin
 * wrapper around this.
 */
export async function runVersionsAudit(args: RunVersionsArgs): Promise<VersionsReport> {
  // 1) Local package.json scan
  const pkgPath = await findPackageJson(args.cwd);
  let localVersions: Record<string, string> = {};
  if (pkgPath) {
    try {
      const pkgText = await readFile(pkgPath, "utf8");
      const pkg = JSON.parse(pkgText);
      localVersions = extractX402Versions(pkg);
    } catch {
      // ignore parse errors; treat as no local versions
    }
  }

  // 2) Service 402 fetch for version hints
  let serviceVersionHints: Record<string, unknown> = {};
  try {
    const res = await args.fetcher(args.service, { method: "GET" });
    const server = res.headers.get("server");
    if (server) serviceVersionHints["server"] = server;
    if (res.status === 402) {
      const bodyText = await res.text();
      const parsed = parseChallengeBody(bodyText);
      if (parsed.ok) {
        serviceVersionHints["x402Version"] = parsed.value.x402Version;
      }
    }
  } catch {
    // Service fetch failure is non-fatal — we can still emit local-side findings.
  }

  // 3) Match against known-skew entries
  const matches: SkewMatch[] = [];
  for (const entry of args.knownSkew.entries) {
    // Map the entry's package name (which may use `python:x402` prefix for
    // non-npm ecosystems) onto a name we can look up. For now, only npm
    // names are matched; non-npm `python:*` entries match if the user
    // is clearly NOT on TS (i.e. no @x402/* deps at all AND service hints
    // a non-TS server). Conservative: skip those unless we have positive
    // evidence.
    if (entry.package.startsWith("python:")) {
      const looksPython =
        Object.keys(localVersions).length === 0 &&
        typeof serviceVersionHints["server"] === "string" &&
        /python|gunicorn|uvicorn|fastapi/i.test(serviceVersionHints["server"] as string);
      if (looksPython) {
        matches.push({ entry, localVersion: "(absent)" });
      }
      continue;
    }
    const localVersion = localVersions[entry.package];
    if (matchesEntry(entry, localVersion)) {
      matches.push({ entry, localVersion: localVersion ?? "(absent)" });
    }
  }

  return {
    service: args.service,
    localPackageJsonPath: pkgPath,
    localVersions,
    serviceVersionHints,
    matches,
    verdict: matches.length > 0 ? "skew_detected" : "no_known_skew",
  };
}

export async function runVersionsCommand(
  opts: VersionsCommandOptions,
  ctx: VersionsRunContext,
): Promise<ExitCode> {
  const service = opts.service;
  if (!service) {
    ctx.stderr.write("error: <service-url> argument is required\n");
    return EXIT_USAGE;
  }
  try {
    new URL(service);
  } catch {
    ctx.stderr.write(`error: <service-url> must be a valid URL (got '${service}')\n`);
    return EXIT_USAGE;
  }

  const format: LogFormat = opts.log ?? "human";
  const color = ctx.color ?? createColorizer({ stream: ctx.stdout as { isTTY?: boolean } });
  const fetcher = ctx.fetch ?? fetch;
  const cwd = opts.cwd ?? process.cwd();
  const knownSkew = opts.knownSkew ?? loadBundledKnownSkew();

  let report: VersionsReport;
  try {
    report = await runVersionsAudit({ service, cwd, fetcher, knownSkew });
  } catch (err) {
    ctx.stderr.write(
      `error: versions audit failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return EXIT_RUNTIME;
  }

  if (format === "json") {
    ctx.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    ctx.stdout.write(`${formatReportHuman(report, color)}\n`);
  }

  return report.verdict === "no_known_skew" ? EXIT_SUCCESS : EXIT_RUNTIME;
}

function formatReportHuman(report: VersionsReport, color: Colorizer): string {
  const lines: string[] = [];
  lines.push(color.paint("bold", `versions ${report.service}`));
  if (report.localPackageJsonPath) {
    lines.push(color.paint("dim", `  package.json: ${report.localPackageJsonPath}`));
    const localList = Object.entries(report.localVersions);
    if (localList.length > 0) {
      for (const [name, version] of localList) {
        lines.push(`    ${color.paint("dim", "local")}  ${name}@${version}`);
      }
    } else {
      lines.push(color.paint("dim", "    (no @x402/* or x402-* deps found)"));
    }
  } else {
    lines.push(color.paint("dim", "  no package.json found in cwd or parents"));
  }
  const hintEntries = Object.entries(report.serviceVersionHints);
  if (hintEntries.length > 0) {
    for (const [k, v] of hintEntries) {
      lines.push(`    ${color.paint("dim", "service")} ${k}: ${String(v)}`);
    }
  } else {
    lines.push(color.paint("dim", "    (no version hints from the service)"));
  }
  lines.push("");
  if (report.matches.length === 0) {
    lines.push(color.paint("green", "✓ no known SDK skew detected"));
  } else {
    for (const m of report.matches) {
      const glyph =
        m.entry.severity === "blocking" ? color.paint("red", "✗") : color.paint("yellow", "⚠");
      lines.push(
        `${glyph} ${color.paint("bold", m.entry.id)} (${m.entry.severity})  ${color.paint("dim", `→ ${m.entry.package} ${m.localVersion}`)}`,
      );
      lines.push(`    ${m.entry.summary}`);
      lines.push(`    ${color.paint("dim", `fix: ${m.entry.fix}`)}`);
      if (m.entry.evidence) {
        lines.push(`    ${color.paint("dim", `evidence: ${m.entry.evidence}`)}`);
      }
    }
    lines.push("");
    lines.push(
      color.paint(
        "yellow",
        `○ VERDICT (exit 2, skew_detected): ${report.matches.length} known skew match(es). Address each before shipping.`,
      ),
    );
  }
  return lines.join("\n");
}
