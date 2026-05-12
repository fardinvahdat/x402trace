import { describe, expect, it } from "vitest";
import { createColorizer } from "../../src/cli/color.js";

describe("createColorizer", () => {
  it("emits ANSI escapes when explicitly enabled", () => {
    const c = createColorizer({ enabled: true });
    expect(c.enabled).toBe(true);
    expect(c.paint("red", "hello")).toBe("\x1b[31mhello\x1b[0m");
  });

  it("passes text through unchanged when explicitly disabled", () => {
    const c = createColorizer({ enabled: false });
    expect(c.enabled).toBe(false);
    expect(c.paint("red", "hello")).toBe("hello");
  });

  it("auto-disables when the stream is not a TTY", () => {
    const c = createColorizer({ stream: { isTTY: false }, env: {} });
    expect(c.enabled).toBe(false);
  });

  it("auto-enables when the stream is a TTY and NO_COLOR is unset", () => {
    const c = createColorizer({ stream: { isTTY: true }, env: {} });
    expect(c.enabled).toBe(true);
  });

  it("respects NO_COLOR even on a TTY", () => {
    const c = createColorizer({ stream: { isTTY: true }, env: { NO_COLOR: "1" } });
    expect(c.enabled).toBe(false);
  });

  it("auto-disables when isTTY is undefined (piped output)", () => {
    const c = createColorizer({ stream: {}, env: {} });
    expect(c.enabled).toBe(false);
  });
});
