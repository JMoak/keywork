import { describe, expect, it } from "vitest";
import { parseChord } from "./keys.ts";
import { defaultTerminalSize, PtyShell } from "./terminal-shell.ts";
import { type FakeBackend, fakePtyBackend } from "./testing/fake-terminal-backend.ts";

function shellOver(backend: FakeBackend = fakePtyBackend()) {
  let notified = 0;
  const shell = new PtyShell({ cwd: "/repo", backend, notify: () => notified++ });
  return { shell, backend, notified: () => notified };
}

function firstOf<T>(items: readonly T[]): T {
  const first = items[0];
  if (first === undefined) throw new Error("expected at least one item");
  return first;
}

describe("PtyShell lifecycle", () => {
  it("opens one process and one surface in the workspace at the default size", () => {
    const { shell, backend } = shellOver();
    expect(backend.processes).toHaveLength(1);
    expect(backend.surfaces).toHaveLength(1);
    expect(firstOf(backend.processes).cwd).toBe("/repo");
    expect(firstOf(backend.surfaces).resizes).toEqual([defaultTerminalSize]);
    expect(shell.running()).toBe(true);
    expect(shell.status()).toBe("shell · fakesh");
  });

  it("feeds child output to the surface and surface replies back to the child", () => {
    const { shell, backend, notified } = shellOver();
    const process = firstOf(backend.processes);
    const surface = firstOf(backend.surfaces);
    process.emit("\x1b[6n");
    expect(surface.fed).toEqual(["\x1b[6n"]);
    expect(notified()).toBeGreaterThan(0);
    surface.reply("\x1b[1;1R");
    expect(process.written).toEqual(["\x1b[1;1R"]);
    expect(shell.running()).toBe(true);
  });

  it("marks the exit in the surface and restarts on enter, never on other keys", () => {
    const { shell, backend } = shellOver();
    firstOf(backend.processes).exit(1);
    expect(shell.running()).toBe(false);
    expect(shell.status()).toBe("shell exited · enter restarts it");
    expect(firstOf(backend.surfaces).fed.at(-1)).toBe(
      "\r\n· shell exited (1) · enter restarts it\r\n",
    );
    expect(shell.handleKey(parseChord("a"), "a")).toBe(false);
    expect(backend.processes).toHaveLength(1);
    expect(shell.handleKey(parseChord("enter"), "\r")).toBe(true);
    expect(backend.processes).toHaveLength(2);
    expect(backend.surfaces).toHaveLength(1);
    expect(shell.status()).toBe("shell · fakesh");
  });

  it("shows a start failure in the surface and lets enter retry", () => {
    const backend = fakePtyBackend();
    backend.failNextOpen("posix_openpt: ENOENT");
    const { shell } = shellOver(backend);
    expect(shell.running()).toBe(false);
    expect(shell.status()).toBe("shell failed · enter retries");
    expect(firstOf(backend.surfaces).fed).toEqual([
      "\r\n· shell failed to start: posix_openpt: ENOENT · enter retries\r\n",
    ]);
    shell.handleKey(parseChord("enter"), "\r");
    expect(shell.running()).toBe(true);
  });

  it("kills the child and releases the surface on dispose, and stays dead afterwards", () => {
    const { shell, backend } = shellOver();
    const process = firstOf(backend.processes);
    shell.dispose();
    expect(process.killed).toBe(1);
    expect(firstOf(backend.surfaces).released).toBe(1);
    expect(shell.running()).toBe(false);
    shell.handleKey(parseChord("enter"), "\r");
    expect(backend.processes).toHaveLength(1);
    process.emit("late output");
    expect(firstOf(backend.surfaces).fed).toEqual([]);
  });

  it("ignores the old child's exit after a restart replaced it", () => {
    const { shell, backend } = shellOver();
    const first = firstOf(backend.processes);
    first.exit(0);
    shell.handleKey(parseChord("enter"), "\r");
    first.exit(0);
    expect(shell.running()).toBe(true);
    expect(firstOf(backend.surfaces).fed).toHaveLength(1);
  });
});

describe("PtyShell key policy (every key the pane receives goes to the pty)", () => {
  it("writes printable keys, escape, arrows, tab, enter, ctrl+c and ctrl+d as the surface encodes them", () => {
    const { shell, backend } = shellOver();
    const process = firstOf(backend.processes);
    const presses: [string, string | undefined][] = [
      ["a", "a"],
      ["shift+a", "A"],
      ["escape", "\x1b"],
      ["up", "\x1b[A"],
      ["tab", "\t"],
      ["enter", "\r"],
      ["ctrl+c", "\x03"],
      ["ctrl+d", "\x04"],
    ];
    for (const [spec, sequence] of presses) {
      expect(shell.handleKey(parseChord(spec), sequence)).toBe(true);
    }
    expect(process.written).toEqual([
      "<a>",
      "<shift+A>",
      "<\x1b>",
      "<\x1b[A>",
      "<\t>",
      "<\r>",
      "<ctrl+\x03>",
      "<ctrl+\x04>",
    ]);
  });

  it("reports a key as unhandled when the surface encodes nothing for it", () => {
    const backend = fakePtyBackend();
    const { shell } = shellOver(backend);
    firstOf(backend.surfaces).encodeKey = () => new Uint8Array();
    expect(shell.handleKey(parseChord("f13"), undefined)).toBe(false);
    expect(firstOf(backend.processes).written).toEqual([]);
  });

  it("sends pastes through the surface's paste encoder so bracketed paste follows the child's mode", () => {
    const { shell, backend } = shellOver();
    expect(shell.handlePaste("ls -la\n")).toBe(true);
    expect(firstOf(backend.processes).written).toEqual(["[paste:ls -la\n]"]);
    firstOf(backend.processes).exit(0);
    expect(shell.handlePaste("gone")).toBe(false);
  });
});

describe("PtyShell geometry and focus", () => {
  it("resizes the surface and the child together, only when the size changes", () => {
    const { shell, backend } = shellOver();
    shell.resize({ cols: 100, rows: 30 });
    shell.resize({ cols: 100, rows: 30 });
    shell.resize({ cols: 40, rows: 10 });
    expect(firstOf(backend.surfaces).resizes).toEqual([
      defaultTerminalSize,
      { cols: 100, rows: 30 },
      { cols: 40, rows: 10 },
    ]);
    expect(firstOf(backend.processes).resizes).toEqual([
      { cols: 100, rows: 30 },
      { cols: 40, rows: 10 },
    ]);
  });

  it("opens a restarted child at the current size", () => {
    const { shell, backend } = shellOver();
    shell.resize({ cols: 50, rows: 12 });
    firstOf(backend.processes).exit(0);
    shell.handleKey(parseChord("enter"), "\r");
    expect(firstOf(backend.surfaces).resizes.at(-1)).toEqual({ cols: 50, rows: 12 });
  });

  it("hands pane focus to the surface so the cursor shows only in the focused pane", () => {
    const { shell, backend } = shellOver();
    shell.focusChanged(true);
    shell.focusChanged(false);
    expect(firstOf(backend.surfaces).focus).toEqual([true, false]);
  });
});
