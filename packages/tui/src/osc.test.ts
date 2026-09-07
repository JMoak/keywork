import { describe, expect, it } from "vitest";
import type { GlyphSupport } from "./capability.ts";
import {
  copyToClipboard,
  popTitle,
  progressOf,
  pushTitle,
  setProgress,
  setTitle,
  TerminalReporter,
  terminalSupport,
  windowTitle,
} from "./osc.ts";

const unicode: GlyphSupport = { glyphTier: 1, nerdFont: false };
const ascii: GlyphSupport = { glyphTier: 0, nerdFont: false };

describe("terminalSupport", () => {
  it("reports progress on Windows Terminal and ConEmu only", () => {
    expect(terminalSupport({ env: { WT_SESSION: "abc" }, tty: true }).progress).toBe(true);
    expect(terminalSupport({ env: { ConEmuANSI: "ON" }, tty: true }).progress).toBe(true);
    expect(terminalSupport({ env: { ConEmuPID: "1234" }, tty: true }).progress).toBe(true);
    expect(terminalSupport({ env: { TERM: "xterm-256color" }, tty: true }).progress).toBe(false);
    expect(terminalSupport({ env: { TERM_PROGRAM: "iTerm.app" }, tty: true }).progress).toBe(false);
  });

  it("titles and clipboard on every live terminal", () => {
    const linux = terminalSupport({ env: { TERM: "xterm-256color" }, tty: true });
    expect(linux).toEqual({ title: true, progress: false, clipboard: true });
    const tmux = terminalSupport({ env: { TERM: "tmux-256color", TMUX: "/tmp/x" }, tty: true });
    expect(tmux).toEqual({ title: true, progress: false, clipboard: true });
  });

  it("stays silent on a dumb terminal or a piped stdout", () => {
    const silent = { title: false, progress: false, clipboard: false };
    expect(terminalSupport({ env: { TERM: "dumb", WT_SESSION: "abc" }, tty: true })).toEqual(
      silent,
    );
    expect(terminalSupport({ env: { WT_SESSION: "abc" }, tty: false })).toEqual(silent);
  });
});

describe("escape strings", () => {
  it("wraps the title in OSC 0 and pushes and pops the title stack with XTWINOPS", () => {
    expect(setTitle("fix the parser · keywork")).toBe("\x1b]0;fix the parser · keywork\x07");
    expect(pushTitle).toBe("\x1b[22;0t");
    expect(popTitle).toBe("\x1b[23;0t");
  });

  it("drops control bytes from a title so a hostile session name cannot end the sequence", () => {
    expect(setTitle("a\x07b\x1bc\ttab")).toBe("\x1b]0;abctab\x07");
  });

  it("encodes OSC 9;4 progress states", () => {
    expect(setProgress("clear")).toBe("\x1b]9;4;0;0\x07");
    expect(setProgress("indeterminate")).toBe("\x1b]9;4;3;0\x07");
    expect(setProgress("paused")).toBe("\x1b]9;4;4;0\x07");
    expect(setProgress("error")).toBe("\x1b]9;4;2;0\x07");
    expect(setProgress("clear", 250)).toBe("\x1b]9;4;0;100\x07");
  });

  it("copies through OSC 52 with base64 of the UTF-8 bytes", () => {
    expect(copyToClipboard("hello")).toBe("\x1b]52;c;aGVsbG8=\x07");
    expect(copyToClipboard("日本語 👋")).toBe("\x1b]52;c;5pel5pys6KqeIPCfkYs=\x07");
    expect(copyToClipboard("")).toBe("\x1b]52;c;\x07");
  });
});

describe("windowTitle", () => {
  it("prefixes the session name with the lifecycle glyph", () => {
    expect(windowTitle({ name: "fix the parser", state: "idle" }, unicode)).toBe(
      "fix the parser · keywork",
    );
    expect(windowTitle({ name: "fix the parser", state: "working" }, unicode)).toBe(
      "▒ fix the parser · keywork",
    );
    expect(windowTitle({ name: "fix the parser", state: "needs-you" }, unicode)).toBe(
      "█ fix the parser · keywork",
    );
    expect(windowTitle({ name: "fix the parser", state: "finished-unseen" }, unicode)).toBe(
      "▓ fix the parser · keywork",
    );
    expect(windowTitle({ name: "fix the parser", state: "failed" }, unicode)).toBe(
      "x fix the parser · keywork",
    );
  });

  it("falls back to ascii marks at glyph tier 0", () => {
    expect(windowTitle({ name: "s", state: "working" }, ascii)).toBe(": s · keywork");
    expect(windowTitle({ name: "s", state: "needs-you" }, ascii)).toBe("# s · keywork");
  });

  it("names the app alone when no session is focused", () => {
    expect(windowTitle({ state: "idle" }, unicode)).toBe("keywork");
  });

  it("maps lifecycle to progress", () => {
    expect(progressOf("idle")).toBe("clear");
    expect(progressOf("working")).toBe("indeterminate");
    expect(progressOf("needs-you")).toBe("paused");
    expect(progressOf("failed")).toBe("error");
    expect(progressOf("finished-unseen")).toBe("clear");
  });
});

describe("TerminalReporter", () => {
  function reporter(support = { title: true, progress: true, clipboard: true }) {
    const bytes: string[] = [];
    const subject = new TerminalReporter((chunk) => bytes.push(chunk), support, unicode);
    return { bytes, subject };
  }

  it("pushes the old title, writes only changes, and restores on end", () => {
    const { bytes, subject } = reporter();
    subject.begin();
    subject.report({ name: "s1", state: "idle" });
    subject.report({ name: "s1", state: "idle" });
    subject.report({ name: "s1", state: "working" });
    subject.report({ name: "s1", state: "working" });
    subject.report({ name: "s1", state: "needs-you" });
    subject.end();
    expect(bytes).toEqual([
      "\x1b[22;0t",
      "\x1b]0;s1 · keywork\x07",
      "\x1b]0;▒ s1 · keywork\x07",
      "\x1b]9;4;3;0\x07",
      "\x1b]0;█ s1 · keywork\x07",
      "\x1b]9;4;4;0\x07",
      "\x1b]9;4;0;0\x07",
      "\x1b[23;0t",
    ]);
  });

  it("writes no progress where the terminal has no progress support", () => {
    const { bytes, subject } = reporter({ title: true, progress: false, clipboard: true });
    subject.begin();
    subject.report({ name: "s1", state: "working" });
    subject.end();
    expect(bytes).toEqual(["\x1b[22;0t", "\x1b]0;▒ s1 · keywork\x07", "\x1b[23;0t"]);
  });

  it("writes nothing at all on a quiet terminal", () => {
    const { bytes, subject } = reporter({ title: false, progress: false, clipboard: false });
    subject.begin();
    subject.report({ name: "s1", state: "working" });
    subject.end();
    expect(bytes).toEqual([]);
  });
});
