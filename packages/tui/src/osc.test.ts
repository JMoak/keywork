import { describe, expect, it } from "vitest";
import type { GlyphSupport } from "./capability.ts";
import {
  colorQueries,
  copyToClipboard,
  focusEventsIn,
  notifyOsc9,
  notifyOsc777,
  parseColorReplies,
  popTitle,
  pushTitle,
  queryAnsiColor,
  queryBackground,
  queryForeground,
  setProgress,
  setTitle,
  TerminalReporter,
  terminalSupport,
  themeChangeReported,
} from "./osc.ts";

const unicode: GlyphSupport = { glyphTier: 1, nerdFont: false };
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
});

describe("terminalSupport", () => {
  it("reports progress on Windows Terminal and ConEmu only", () => {
    expect(terminalSupport({ env: { WT_SESSION: "abc" }, tty: true }).progress).toBe(true);
    expect(terminalSupport({ env: { ConEmuANSI: "ON" }, tty: true }).progress).toBe(true);
    expect(terminalSupport({ env: { ConEmuPID: "1234" }, tty: true }).progress).toBe(true);
    expect(terminalSupport({ env: { TERM: "xterm-256color" }, tty: true }).progress).toBe(false);
    expect(terminalSupport({ env: { TERM_PROGRAM: "iTerm.app" }, tty: true }).progress).toBe(false);
  });

  it("stays silent on a dumb terminal or a piped stdout", () => {
    const silent = { title: false, progress: false, clipboard: false, hyperlinks: false };
    expect(terminalSupport({ env: { TERM: "dumb", WT_SESSION: "abc" }, tty: true })).toEqual(
      silent,
    );
    expect(terminalSupport({ env: { WT_SESSION: "abc" }, tty: false })).toEqual(silent);
  });

  it("opens hyperlinks only on terminals known to support OSC 8", () => {
    const links = (env: Record<string, string>) => terminalSupport({ env, tty: true }).hyperlinks;
    expect(links({ WT_SESSION: "abc" })).toBe(true);
    expect(links({ KITTY_WINDOW_ID: "1" })).toBe(true);
    expect(links({ TERM: "xterm-kitty" })).toBe(true);
    expect(links({ TERM: "xterm-ghostty" })).toBe(true);
    expect(links({ GHOSTTY_RESOURCES_DIR: "/usr/share/ghostty" })).toBe(true);
    expect(links({ TERM_PROGRAM: "WezTerm" })).toBe(true);
    expect(links({ TERM_PROGRAM: "iTerm.app" })).toBe(true);
    expect(links({ TERM: "foot" })).toBe(true);
    expect(links({ VTE_VERSION: "7600" })).toBe(true);
    expect(links({ KONSOLE_VERSION: "230804" })).toBe(true);
    expect(links({ VTE_VERSION: "4800" })).toBe(false);
    expect(links({ TERM: "xterm-256color" })).toBe(false);
    expect(links({})).toBe(false);
  });

  it("keeps hyperlinks off inside multiplexers and over ssh, where the host is unknown", () => {
    const links = (env: Record<string, string>) => terminalSupport({ env, tty: true }).hyperlinks;
    expect(links({ WT_SESSION: "abc", TMUX: "/tmp/tmux-1000/default,1,0" })).toBe(false);
    expect(links({ KITTY_WINDOW_ID: "1", TERM: "screen-256color" })).toBe(false);
    expect(links({ TERM_PROGRAM: "WezTerm", ZELLIJ: "0" })).toBe(false);
    expect(links({ KITTY_WINDOW_ID: "1", SSH_CONNECTION: "10.0.0.2 5022 10.0.0.1 22" })).toBe(
      false,
    );
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
});

describe("TerminalReporter", () => {
  function reporter(support = { title: true, progress: true, clipboard: true, hyperlinks: false }) {
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
    const { bytes, subject } = reporter({
      title: true,
      progress: false,
      clipboard: true,
      hyperlinks: false,
    });
    subject.begin();
    subject.report({ name: "s1", state: "working" });
    subject.end();
    expect(bytes).toEqual(["\x1b[22;0t", "\x1b]0;▒ s1 · keywork\x07", "\x1b[23;0t"]);
  });

  it("writes nothing at all on a quiet terminal", () => {
    const { bytes, subject } = reporter({
      title: false,
      progress: false,
      clipboard: false,
      hyperlinks: false,
    });
    subject.begin();
    subject.report({ name: "s1", state: "working" });
    subject.end();
    expect(bytes).toEqual([]);
  });
});

describe("theme reports (mode 2031)", () => {
  it("hears the dark and light reports anywhere in a chunk", () => {
    expect(themeChangeReported("\x1b[?997;1n")).toBe(true);
    expect(themeChangeReported("\x1b[?997;2n")).toBe(true);
    expect(themeChangeReported("a\x1b[I\x1b[?997;2nb")).toBe(true);
  });

  it("ignores the query, other DSR replies and plain keys", () => {
    expect(themeChangeReported("\x1b[?996n")).toBe(false);
    expect(themeChangeReported("\x1b[?997;3n")).toBe(false);
    expect(themeChangeReported("\x1b[0n")).toBe(false);
    expect(themeChangeReported("?997;1n")).toBe(false);
  });
});

describe("TerminalReporter refresh", () => {
  it("rewrites the same title after a refresh so an editor's title does not stick", () => {
    const writes: string[] = [];
    const reporter = new TerminalReporter(
      (bytes) => writes.push(bytes),
      { title: true, progress: false, clipboard: true, hyperlinks: false },
      { glyphTier: 2, nerdFont: false },
    );
    reporter.report({ name: "a", state: "idle" });
    reporter.report({ name: "a", state: "idle" });
    expect(writes).toEqual([setTitle("a · keywork")]);
    reporter.refresh();
    reporter.report({ name: "a", state: "idle" });
    expect(writes).toEqual([setTitle("a · keywork"), setTitle("a · keywork")]);
  });
});
