import { detectCapabilities } from "@keywork/tui";
import { describe, expect, it } from "vitest";
import { doctorCommand, doctorReport } from "./doctor.ts";
import { composeInference } from "./inference/runtime.ts";

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
  it("logs the report for the given environment and exits 0", async () => {
    const lines: string[] = [];
    const code = await doctorCommand(
      { env: { TERM: "xterm-256color", LANG: "C" }, platform: "linux" },
      (line) => lines.push(line),
    );
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("terminal     unrecognized");
    expect(lines.join("\n")).toContain("color        256 colors");
  });

  it("lists each connected provider's models with declared or assumed windows", async () => {
    const { registry } = composeInference({
      env: { OPENAI_API_KEY: "k" },
      config: {
        connections: { ollama: { endpoint: "http://localhost:11434/v1", models: ["qwen3"] } },
        models: { qwen3: { contextWindow: 32_768 } },
      },
      credentials: {},
      observations: { ollama: { models: ["qwen3", "llama3"] } },
    });
    const lines: string[] = [];
    await doctorCommand(
      { env: { WT_SESSION: "guid" }, platform: "win32" },
      (line) => lines.push(line),
      async () => registry,
    );
    const report = lines.join("\n");
    expect(report).toContain("context      ollama: qwen3 33k · llama3 assumed");
    expect(report).toContain("             openai: gpt-5-mini assumed");
  });

  it("says when no provider is connected, and shrugs off a failed inference load", async () => {
    const lines: string[] = [];
    await doctorCommand(
      { env: {}, platform: "linux" },
      (line) => lines.push(line),
      async () => {
        throw new Error("config broke");
      },
    );
    expect(lines.join("\n")).not.toContain("context ");

    lines.length = 0;
    const { registry } = composeInference({ env: {}, config: {}, credentials: {} });
    await doctorCommand(
      { env: {}, platform: "linux" },
      (line) => lines.push(line),
      async () => registry,
    );
    expect(lines.join("\n")).toContain("context      no provider connected yet · keywork connect");
  });
});
