import { detectCapabilities } from "@keywork/tui";
import { describe, expect, it } from "vitest";
import { doctorCommand, doctorReport } from "./doctor.ts";

function report(env: Record<string, string | undefined>, platform = "linux"): string {
  return doctorReport(detectCapabilities({ env, platform }));
}

describe("doctorReport", () => {
  it("prints the full profile for a major terminal", () => {
    expect(report({ WT_SESSION: "guid" }, "win32")).toBe(
      [
        "keywork doctor",
        "",
        "terminal     Windows Terminal",
        "color        truecolor",
        "sync frames  yes, DEC 2026 wraps every paint",
        "glyph tier   2 of 2, sub-cell glyphs",
        "nerd font    off, opt in with KEYWORK_NERD_FONT=1",
        "sample       ░▒▓█  ╭─╮│╰─╯  ▖▌▙█▛  ⣀⣤⣶⣿",
      ].join("\n"),
    );
  });

  it("renders the forced tier 1 sample from the Unicode working set", () => {
    const lines = report({ WT_SESSION: "guid", KEYWORK_TIER: "1" }).split("\n");
    expect(lines).toContain("glyph tier   1 of 2, Unicode box and block (forced by KEYWORK_TIER)");
    expect(lines).toContain("sample       ░▒▓█  ╭─╮│╰─╯  ░▒▓█x  ░▒▓█");
  });

  it("renders the forced tier 0 sample in pure ASCII, top to bottom", () => {
    const output = report({ WT_SESSION: "guid", KEYWORK_TIER: "0" });
    expect(output).toContain("sample       .:+#  +-+|+-+  .:+#x  .:+#");
    expect([...output].every((glyph) => glyph.charCodeAt(0) <= 0x7e)).toBe(true);
  });

  it("says why sync frames are off inside tmux", () => {
    expect(report({ WT_SESSION: "guid", TMUX: "/tmp/tmux-1000/default,1,0" })).toContain(
      "sync frames  no, tmux nesting turns it off",
    );
    expect(report({ TMUX: "/tmp/tmux-1000/default,1,0" })).toContain("nested in tmux");
  });

  it("reflects the Nerd Font opt-in", () => {
    expect(report({ WT_SESSION: "guid", KEYWORK_NERD_FONT: "1" })).toContain(
      "nerd font    on, garnish glyphs enabled",
    );
  });

  it("names monochrome color when NO_COLOR is set", () => {
    expect(report({ WT_SESSION: "guid", NO_COLOR: "1" })).toContain("color        monochrome");
  });
});

describe("doctorCommand", () => {
  it("logs the report for the given environment and exits 0", () => {
    const lines: string[] = [];
    const code = doctorCommand(
      { env: { TERM: "xterm-256color", LANG: "C" }, platform: "linux" },
      (line) => lines.push(line),
    );
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("terminal     unrecognized");
    expect(lines.join("\n")).toContain("color        256 colors");
  });
});
