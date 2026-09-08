import { describe, expect, it } from "vitest";
import type { GlyphSupport } from "./capability.ts";
import {
  bell,
  colorQueries,
  colorRepliesComplete,
  copyToClipboard,
  disableFocusReporting,
  enableFocusReporting,
  focusEventsIn,
  notifyOsc9,
  notifyOsc777,
  parseColorReplies,
  popTitle,
  progressOf,
  pushTitle,
  queryAnsiColor,
  queryBackground,
  queryForeground,
  setProgress,
  setTitle,
  TerminalReporter,
  terminalSupport,
  windowTitle,
} from "./osc.ts";

const unicode: GlyphSupport = { glyphTier: 1, nerdFont: false };
const ascii: GlyphSupport = { glyphTier: 0, nerdFont: false };

describe("color queries", () => {
  it("asks for the ground, the ink, and the ANSI 16 in one burst", () => {
    expect(queryBackground).toBe("\x1b]11;?\x1b\\");
    expect(queryForeground).toBe("\x1b]10;?\x1b\\");
    expect(queryAnsiColor(12)).toBe("\x1b]4;12;?\x1b\\");
    const burst = colorQueries();
    expect(burst.startsWith(queryBackground + queryForeground)).toBe(true);
    expect(burst.endsWith(queryAnsiColor(15))).toBe(true);
  });

  it("reads X11 rgb specs at every digit width and both terminators", () => {
    const colors = parseColorReplies(
      "\x1b]11;rgb:1a1a/1b1b/2626\x1b\\\x1b]10;rgb:c0/ca/f5\x07\x1b]4;12;rgb:7/a/f\x1b\\",
    );
    expect(colors.background).toBe("#1a1b26");
    expect(colors.foreground).toBe("#c0caf5");
    expect(colors.ansi.get(12)).toBe("#77aaff");
  });

  it("reads hash forms and ignores replies it cannot parse", () => {
    const colors = parseColorReplies("\x1b]11;#fff\x1b\\\x1b]4;1;#cd0000\x1b\\\x1b]10;nope\x1b\\");
    expect(colors.background).toBe("#ffffff");
    expect(colors.ansi.get(1)).toBe("#cd0000");
    expect(colors.foreground).toBeUndefined();
  });

  it("knows when every reply has arrived", () => {
    const partial = parseColorReplies("\x1b]11;rgb:00/00/00\x1b\\");
    expect(colorRepliesComplete(partial)).toBe(false);
    const all = [
      "\x1b]11;rgb:00/00/00\x1b\\",
      "\x1b]10;rgb:ff/ff/ff\x1b\\",
      ...Array.from({ length: 16 }, (_, index) => `\x1b]4;${index};rgb:80/80/80\x1b\\`),
    ].join("");
    expect(colorRepliesComplete(parseColorReplies(all))).toBe(true);
  });
});

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

  it("switches focus reporting with DECSET 1004 and rings the bell as one byte", () => {
    expect(enableFocusReporting).toBe("\x1b[?1004h");
    expect(disableFocusReporting).toBe("\x1b[?1004l");
    expect(bell).toBe("\x07");
  });

  it("notifies through OSC 777 with title and body, and OSC 9 with one text", () => {
    expect(notifyOsc777("fix the parser", "needs you · ask")).toBe(
      "\x1b]777;notify;fix the parser;needs you · ask\x07",
    );
    expect(notifyOsc9("fix the parser · needs you · ask")).toBe(
      "\x1b]9;fix the parser · needs you · ask\x07",
    );
  });

  it("keeps a hostile title from ending a notification or shifting its fields", () => {
    expect(notifyOsc777("a\x07b;c", "d\x1be")).toBe("\x1b]777;notify;ab,c;de\x07");
    expect(notifyOsc9("a\x07b\x1bc")).toBe("\x1b]9;abc\x07");
  });
});

describe("focusEventsIn", () => {
  it("reads CSI I and CSI O in order, ignoring everything around them", () => {
    expect(focusEventsIn("\x1b[I")).toEqual(["focus-in"]);
    expect(focusEventsIn("\x1b[O")).toEqual(["focus-out"]);
    expect(focusEventsIn("\x1b[Oabc\x1b[A\x1b[I")).toEqual(["focus-out", "focus-in"]);
  });

  it("finds no focus report in ordinary keys", () => {
    expect(focusEventsIn("")).toEqual([]);
    expect(focusEventsIn("\x1b[A\x1b[1;5I")).toEqual([]);
    expect(focusEventsIn("IO")).toEqual([]);
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
