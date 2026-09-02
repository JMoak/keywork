import { detectCapabilities } from "@keywork/tui";
import { describe, expect, it } from "vitest";
import { doctorCommand, doctorReport, renderDoctorReport, workspaceDoctorFacts } from "./doctor.ts";
import { composeInference } from "./inference/runtime.ts";

function report(env: Record<string, string | undefined>, platform = "linux"): string {
  return renderDoctorReport(doctorReport(detectCapabilities({ env, platform })));
}

describe("doctorReport", () => {
  it("exposes the report as labeled rows before any rendering", () => {
    const { rows } = doctorReport(
      detectCapabilities({ env: { WT_SESSION: "guid" }, platform: "win32" }),
    );
    expect(rows.map((row) => row.label)).toEqual([
      "terminal",
      "color",
      "sync frames",
      "glyph tier",
      "nerd font",
      "sample",
    ]);
    expect(rows[0]?.value).toBe("Windows Terminal");
  });

  it("adds one context row per provider, continuation rows unlabeled", () => {
    const { registry } = composeInference({
      env: { OPENAI_API_KEY: "k" },
      config: { connections: { ollama: { endpoint: "http://localhost:11434/v1", models: ["q"] } } },
      credentials: {},
    });
    const rows = doctorReport(detectCapabilities({ env: {}, platform: "linux" }), registry).rows;
    expect(rows.slice(-2).map((row) => row.label)).toEqual(["context", ""]);
  });

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

describe("workspace doctor rows", () => {
  const profile = detectCapabilities({ env: { WT_SESSION: "guid" }, platform: "linux" });

  it("says when the repo map is configured off", () => {
    const { rows } = doctorReport(profile, undefined, {
      trusted: true,
      repoMapSetting: "off",
    });
    expect(rows.at(-1)).toEqual({ label: "repo map", value: "off in keywork.json" });
  });

  it("says when the workspace is untrusted", () => {
    const { rows } = doctorReport(profile, undefined, { trusted: false });
    expect(rows.at(-1)).toEqual({
      label: "repo map",
      value: "workspace untrusted, not scanned",
    });
  });

  it("reports map size, staleness, and ignore health with malformed lines listed", () => {
    const { rows } = doctorReport(profile, undefined, {
      trusted: true,
      repoMap: {
        files: 12,
        symbols: 80,
        ignoredPaths: 3,
        truncated: false,
        stale: false,
        ignoreProblems: [
          {
            file: ".keyworkignore",
            line: 4,
            text: "[oops",
            reason: "character class is never closed",
          },
        ],
      },
    });
    expect(rows).toContainEqual({
      label: "repo map",
      value: "12 files · 80 symbols · fresh",
    });
    expect(rows).toContainEqual({
      label: "ignore",
      value: "3 paths ignored · 1 malformed line",
    });
    expect(rows.at(-1)).toEqual({
      label: "",
      value: ".keyworkignore:4 skipped · character class is never closed",
    });
  });

  it("lists each mcp server with its transport", () => {
    const { rows } = doctorReport(profile, undefined, {
      trusted: true,
      mcpServers: {
        files: { transport: "stdio", command: "files-server" },
        remote: { transport: "http", url: "https://mcp.example/api" },
      },
    });
    expect(rows.slice(-2)).toEqual([
      { label: "mcp", value: "files · stdio · files-server" },
      { label: "", value: "remote · http · https://mcp.example/api" },
    ]);
  });

  it("scans a trusted workspace end to end through workspaceDoctorFacts", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const cwd = await mkdtemp(join(tmpdir(), "keywork-doctor-"));
    try {
      await writeFile(join(cwd, "main.ts"), "export const main = 1;", "utf8");
      await writeFile(join(cwd, ".keyworkignore"), "[broken\n*.log", "utf8");
      const facts = await workspaceDoctorFacts(cwd, true, {});
      expect(facts.repoMap?.files).toBe(1);
      expect(facts.repoMap?.ignoreProblems).toHaveLength(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("never scans an untrusted directory", async () => {
    const facts = await workspaceDoctorFacts("C:/definitely/not/scanned", false, {});
    expect(facts.repoMap).toBeUndefined();
    expect(facts.trusted).toBe(false);
  });
});

describe("crash log section", () => {
  it("renders the recorded crashes with their path", () => {
    const { rows } = doctorReport(
      detectCapabilities({ env: { WT_SESSION: "guid" }, platform: "win32" }),
      undefined,
      { crashLog: { path: "C:/logs/tui-crash.log", entries: 2, lastAt: "2026-09-01T00:00:00Z" } },
    );
    expect(rows.slice(-2)).toEqual([
      { label: "crash log", value: "2 crashes recorded · last 2026-09-01T00:00:00Z" },
      { label: "", value: "C:/logs/tui-crash.log" },
    ]);
  });

  it("says none recorded for an empty log", () => {
    const { rows } = doctorReport(
      detectCapabilities({ env: { WT_SESSION: "guid" }, platform: "win32" }),
      undefined,
      { crashLog: { path: "C:/logs/tui-crash.log", entries: 0 } },
    );
    expect(rows.at(-1)).toEqual({ label: "crash log", value: "none recorded" });
  });
});
