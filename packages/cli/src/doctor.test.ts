import { detectCapabilities } from "@keywork/tui";
import { describe, expect, it } from "vitest";
import { doctorCommand, doctorReport, renderDoctorReport, workspaceDoctorFacts } from "./doctor.ts";
import { composeInference } from "./inference/runtime.ts";

function report(env: Record<string, string | undefined>, platform = "linux"): string {
  return renderDoctorReport(doctorReport(detectCapabilities({ env, platform })));
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

  it("renders the forced tier 0 sample in pure ASCII, top to bottom", () => {
    const output = report({ WT_SESSION: "guid", KEYWORK_TIER: "0" });
    expect(output).toContain("sample       .:+#  +-+|+-+  .:+#x  .:+#");
    expect([...output].every((glyph) => glyph.charCodeAt(0) <= 0x7e)).toBe(true);
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

describe("language server rows", () => {
  const profile = detectCapabilities({ env: { WT_SESSION: "guid" }, platform: "linux" });
  const rowsFor = (facts: Parameters<typeof doctorReport>[2]) =>
    doctorReport(profile, undefined, facts).rows.filter(
      (row, index, rows) =>
        row.label === "language servers" ||
        (row.label === "" && rows.slice(0, index).some((r) => r.label === "language servers")),
    );

  it("lists each server with its live state", () => {
    const rows = rowsFor({
      trusted: true,
      lspSetting: "auto",
      languageServers: {
        servers: [
          {
            language: "typescript",
            command: "typescript-language-server --stdio",
            state: "ready",
            pid: 4242,
          },
          { language: "python", command: "pyright-langserver --stdio", state: "missing" },
          { language: "rust", command: "rust-analyzer", state: "failed", detail: "exit 101" },
          { language: "go", command: "gopls", state: "idle" },
        ],
      },
    });
    expect(rows).toEqual([
      { label: "language servers", value: "go · idle · gopls" },
      { label: "", value: "python · missing · pyright-langserver --stdio not on PATH" },
      { label: "", value: "rust · failed · exit 101" },
      { label: "", value: "typescript · ready · pid 4242" },
    ]);
    expect(renderDoctorReport({ rows })).toContain("language servers  go · idle · gopls");
  });

  it("reports the built-in table idle from a fresh process", async () => {
    const facts = await workspaceDoctorFacts("C:/definitely/not/scanned", true, {
      repoMap: "off",
      lsp: "auto",
    });
    expect(
      facts.languageServers?.servers.map((server) => `${server.language}:${server.state}`),
    ).toEqual(["typescript:idle", "python:idle", "go:idle", "rust:idle"]);
    expect(
      (await workspaceDoctorFacts("C:/nope", true, { repoMap: "off" })).languageServers,
    ).toBeUndefined();
  });
});
