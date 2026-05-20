/**
 * Locks the structure of the bazaar production-set fixtures so v0.3.2's
 * D.1 / D.2 / D.3 sub-check work can rely on the shape. See
 * `tests/fixtures/bazaar/production-set/README.md` for provenance and
 * the schema this test enforces.
 *
 * Not a behavioral test of bazaar-check itself — that comes in v0.3.2
 * when the sub-checks land. This is a structural contract test.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "..", "fixtures", "bazaar", "production-set");

interface ProductionSetFixture {
  source: {
    contributor: string;
    context: string;
    methodology: string;
    tool_version: string;
    captured_at: string;
    summary: string;
  };
  fixtures: ReadonlyArray<{
    url: string;
    expected_verdict_at_capture: "looks_correct" | "implementation_issue" | "upstream_issue";
    notes: string | null;
  }>;
}

function loadFixture(filename: string): ProductionSetFixture {
  const text = readFileSync(join(FIXTURE_DIR, filename), "utf8");
  return JSON.parse(text) as ProductionSetFixture;
}

describe("bazaar production-set fixtures", () => {
  it("contains the TomSmart_ai 2026-05-20 fixture", () => {
    const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));
    expect(files).toContain("tomsmart-2026-05-20.json");
  });

  describe("tomsmart-2026-05-20.json", () => {
    const fixture = loadFixture("tomsmart-2026-05-20.json");

    it("has the documented source metadata", () => {
      expect(fixture.source.contributor).toBe("TomSmart_ai");
      expect(fixture.source.tool_version).toBe("0.3.0");
      expect(fixture.source.captured_at).toBe("2026-05-20");
    });

    it("contains exactly 19 fixture entries", () => {
      expect(fixture.fixtures).toHaveLength(19);
    });

    it("all 19 entries report implementation_issue at capture (per the summary)", () => {
      for (const entry of fixture.fixtures) {
        expect(entry.expected_verdict_at_capture).toBe("implementation_issue");
      }
    });

    it("every URL is a parseable https URL", () => {
      for (const entry of fixture.fixtures) {
        expect(() => new URL(entry.url)).not.toThrow();
        expect(entry.url.startsWith("https://")).toBe(true);
      }
    });

    it("every entry conforms to the schema (url + verdict + notes)", () => {
      for (const entry of fixture.fixtures) {
        expect(typeof entry.url).toBe("string");
        expect(["looks_correct", "implementation_issue", "upstream_issue"]).toContain(
          entry.expected_verdict_at_capture,
        );
        expect(entry.notes === null || typeof entry.notes === "string").toBe(true);
      }
    });

    it("flags the lowpaymentfee.com cluster with a do-not-reuse marker", () => {
      // The README documents these as 'do not reuse without re-verification'
      // due to suspicious path patterns (SSN, medical records, etc.). Locking
      // the marker so v0.3.2 work doesn't accidentally lose the warning.
      const flagged = fixture.fixtures.filter(
        (e) => e.url.includes("lowpaymentfee.com") && (e.notes ?? "").includes("do not reuse"),
      );
      // 5 lowpaymentfee.com URLs in the set; all 5 carry the marker
      expect(flagged.length).toBe(5);
    });

    it("flags the polyodds.bet cross-reference to the Max Discord case", () => {
      const polyodds = fixture.fixtures.find((e) => e.url.includes("polyodds.bet"));
      expect(polyodds?.notes).toMatch(/Max/);
    });
  });
});
