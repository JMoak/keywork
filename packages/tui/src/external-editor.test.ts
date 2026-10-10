import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type EditorCommand,
  editDraftExternally,
  editorCommandFor,
  type RendererHold,
  shellWords,
} from "./external-editor.ts";
import {
  disableFocusReporting,
  disableThemeReports,
  enableFocusReporting,
  enableThemeReports,
} from "./osc.ts";
import { rendererHold } from "./renderer-hold.ts";

describe("editorCommandFor", () => {
  it("prefers VISUAL, then EDITOR, then the platform fallback", () => {
    expect(editorCommandFor({ VISUAL: "code --wait", EDITOR: "vim" }, "linux")).toEqual({
      program: "code",
      args: ["--wait"],
    });
    expect(editorCommandFor({ EDITOR: "vim" }, "linux")).toEqual({ program: "vim", args: [] });
    expect(editorCommandFor({ VISUAL: "  " }, "win32")).toEqual({ program: "notepad", args: [] });
    expect(editorCommandFor({}, "darwin")).toEqual({ program: "vi", args: [] });
  });

  it("splits shell words and keeps quoted paths whole", () => {
    expect(shellWords('"C:\\Program Files\\Editor\\ed.exe" -n --wait')).toEqual([
      "C:\\Program Files\\Editor\\ed.exe",
      "-n",
      "--wait",
    ]);
    expect(shellWords("nvim 'my config'")).toEqual(["nvim", "my config"]);
  });
});

describe("editDraftExternally", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "keywork-editor-test-"));
    dirs.push(dir);
    return dir;
  }

  function hold(log: string[]): RendererHold {
    return { suspend: () => log.push("suspend"), resume: () => log.push("resume") };
  }

  it("hands the draft to the editor, suspends around it and loads the edit back", async () => {
    const log: string[] = [];
    const seen: EditorCommand[] = [];
    const dir = tempDir();
    const result = await editDraftExternally("first draft", {
      hold: hold(log),
      env: { EDITOR: "fake-editor --flag" },
      platform: "linux",
      tempDir: dir,
      run: async (command, file) => {
        seen.push(command);
        log.push(`edit ${readFileSync(file, "utf8")}`);
        writeFileSync(file, "second draft\n");
        return 0;
      },
    });
    expect(result).toEqual({ kind: "edited", text: "second draft" });
    expect(seen).toEqual([{ program: "fake-editor", args: ["--flag"] }]);
    expect(log).toEqual(["suspend", "edit first draft", "resume"]);
  });

  it("reports an untouched draft as unchanged and ignores the editor's trailing newline", async () => {
    const result = await editDraftExternally("same\n", {
      hold: hold([]),
      env: {},
      platform: "linux",
      tempDir: tempDir(),
      run: async (_command, file) => {
        writeFileSync(file, "same\n");
        return 0;
      },
    });
    expect(result).toEqual({ kind: "unchanged" });
  });

  it("keeps the draft when the editor fails to start or exits non-zero", async () => {
    const log: string[] = [];
    const dir = tempDir();
    const crashed = await editDraftExternally("keep me", {
      hold: hold(log),
      env: { EDITOR: "missing-editor" },
      platform: "linux",
      tempDir: dir,
      run: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(crashed).toEqual({
      kind: "failed",
      reason: "missing-editor did not start · ENOENT",
    });
    const refused = await editDraftExternally("keep me", {
      hold: hold(log),
      env: { EDITOR: "vim" },
      platform: "linux",
      tempDir: dir,
      run: async (_command, file) => {
        writeFileSync(file, "partial");
        return 1;
      },
    });
    expect(refused).toEqual({ kind: "failed", reason: "vim exited with code 1" });
    expect(log).toEqual(["suspend", "resume", "suspend", "resume"]);
  });

  it("removes its draft file afterwards", async () => {
    const dir = tempDir();
    let file = "";
    await editDraftExternally("tidy", {
      hold: hold([]),
      env: {},
      platform: "linux",
      tempDir: dir,
      run: async (_command, path) => {
        file = path;
        return 0;
      },
    });
    expect(file.startsWith(dir)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });
});

describe("rendererHold", () => {
  it("pops keywork's own modes before the renderer suspends and pushes them back after", () => {
    const log: string[] = [];
    const held = rendererHold({
      renderer: {
        suspend: () => log.push("renderer.suspend"),
        resume: () => log.push("renderer.resume"),
      },
      write: (bytes) => log.push(bytes),
      modes: () => ({ focusReporting: true, themeReports: true }),
      afterResume: () => log.push("after"),
    });
    held.suspend();
    held.resume();
    expect(log).toEqual([
      disableThemeReports,
      disableFocusReporting,
      "renderer.suspend",
      "renderer.resume",
      enableFocusReporting,
      enableThemeReports,
      "after",
    ]);
  });

  it("leaves modes it never enabled alone", () => {
    const log: string[] = [];
    const held = rendererHold({
      renderer: { suspend: () => log.push("suspend"), resume: () => log.push("resume") },
      write: (bytes) => log.push(bytes),
      modes: () => ({ focusReporting: false, themeReports: false }),
    });
    held.suspend();
    held.resume();
    expect(log).toEqual(["suspend", "resume"]);
  });
});
