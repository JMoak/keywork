import { describe, expect, it } from "vitest";
import {
  askReason,
  inboxReason,
  type NotificationTransport,
  Notifier,
  notificationBytes,
  notificationTransport,
  transportFor,
  type WorkSnapshot,
} from "./notifications.ts";

const quiet: WorkSnapshot = { title: "fix the parser", asks: [], inbox: 0 };

function asking(...asks: string[]): WorkSnapshot {
  return { ...quiet, asks };
}

function inboxAt(inbox: number): WorkSnapshot {
  return { ...quiet, inbox };
}

function notifier(transport: NotificationTransport = "osc777") {
  const writes: string[] = [];
  const subject = new Notifier((bytes) => writes.push(bytes), transport);
  return { subject, writes };
}

describe("notificationTransport", () => {
  const fixtures: ReadonlyArray<[string, Record<string, string>, NotificationTransport]> = [
    ["rxvt", { TERM: "rxvt-unicode-256color" }, "osc777"],
    ["ghostty", { TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty" }, "osc777"],
    ["WezTerm", { TERM: "wezterm", TERM_PROGRAM: "WezTerm" }, "osc777"],
    ["VTE", { TERM: "xterm-256color", VTE_VERSION: "7402" }, "osc777"],
    ["Windows Terminal", { TERM: "xterm-256color", WT_SESSION: "abc" }, "osc9"],
    ["iTerm2", { TERM: "xterm-256color", TERM_PROGRAM: "iTerm.app" }, "osc9"],
    ["kitty", { TERM: "xterm-kitty" }, "osc9"],
    ["plain xterm", { TERM: "xterm-256color" }, "bell"],
    ["conhost", {}, "bell"],
    [
      "tmux over WezTerm",
      { TERM: "tmux-256color", TMUX: "/tmp/x", TERM_PROGRAM: "WezTerm" },
      "bell",
    ],
  ];

  it.each(fixtures)("picks %s", (_name, env, expected) => {
    expect(notificationTransport({ env, tty: true })).toBe(expected);
  });

  it("is off on a dumb terminal or a piped stdout", () => {
    expect(notificationTransport({ env: { TERM: "dumb", WT_SESSION: "abc" }, tty: true })).toBe(
      "off",
    );
    expect(notificationTransport({ env: { WT_SESSION: "abc" }, tty: false })).toBe("off");
  });

  it("lets policy force a transport or silence, and auto defers to detection", () => {
    const wt = { env: { WT_SESSION: "abc" }, tty: true };
    expect(transportFor("auto", wt)).toBe("osc9");
    expect(transportFor("bell", wt)).toBe("bell");
    expect(transportFor("osc777", wt)).toBe("osc777");
    expect(transportFor("off", wt)).toBe("off");
  });
});

describe("notificationBytes", () => {
  const notice = { title: "fix the parser", reason: askReason };

  it("emits the exact bytes per transport", () => {
    expect(notificationBytes("osc777", notice)).toBe(
      "\x1b]777;notify;fix the parser;needs you · ask\x07",
    );
    expect(notificationBytes("osc9", notice)).toBe("\x1b]9;fix the parser · needs you · ask\x07");
    expect(notificationBytes("bell", notice)).toBe("\x07");
    expect(notificationBytes("off", notice)).toBe("");
  });

  it("runs the title through the title-safe sanitizer", () => {
    const hostile = { title: "a\x07b\x1b;c", reason: inboxReason(3) };
    expect(notificationBytes("osc9", hostile)).toBe("\x1b]9;ab;c · inbox · 3 waiting\x07");
    expect(notificationBytes("osc777", hostile)).toBe("\x1b]777;notify;ab,c;inbox · 3 waiting\x07");
  });
});

describe("Notifier", () => {
  it("assumes focus until the terminal reports otherwise, so nothing notifies", () => {
    const { subject, writes } = notifier();
    subject.observe(quiet);
    subject.observe(asking("fix the parser"));
    subject.observe(inboxAt(5));
    expect(writes).toEqual([]);
  });

  it("notifies once for an ask that arrives unfocused and stays quiet for the next one", () => {
    const { subject, writes } = notifier();
    subject.observe(quiet);
    subject.focusChanged("focus-out");
    subject.observe(asking("fix the parser"));
    subject.observe(asking("fix the parser"));
    subject.observe(asking("fix the parser", "write the tests"));
    expect(writes).toEqual(["\x1b]777;notify;fix the parser;needs you · ask\x07"]);
  });

  it("notifies again after a refocus when a new ask arrives", () => {
    const { subject, writes } = notifier();
    subject.observe(quiet);
    subject.focusChanged("focus-out");
    subject.observe(asking("fix the parser"));
    subject.focusChanged("focus-in");
    subject.observe(quiet);
    subject.focusChanged("focus-out");
    subject.observe(asking("write the tests"));
    expect(writes).toEqual([
      "\x1b]777;notify;fix the parser;needs you · ask\x07",
      "\x1b]777;notify;write the tests;needs you · ask\x07",
    ]);
  });

  it("names the ask that is new when another pane was already waiting", () => {
    const { subject, writes } = notifier();
    subject.observe(asking("fix the parser"));
    subject.focusChanged("focus-out");
    subject.observe(asking("fix the parser", "write the tests"));
    expect(writes).toEqual(["\x1b]777;notify;write the tests;needs you · ask\x07"]);
  });

  it("never notifies for a completion, a failure, or an ask answered elsewhere", () => {
    const { subject, writes } = notifier();
    subject.focusChanged("focus-out");
    subject.observe({ ...quiet, title: "finished" });
    subject.observe({ ...quiet, title: "failed" });
    subject.observe(asking("fix the parser"));
    writes.length = 0;
    subject.observe(quiet);
    expect(writes).toEqual([]);
  });

  it("notifies once when the inbox crosses its threshold, with the count", () => {
    const { subject, writes } = notifier("osc9");
    subject.observe(inboxAt(2));
    subject.focusChanged("focus-out");
    subject.observe(inboxAt(2));
    subject.observe(inboxAt(3));
    subject.observe(inboxAt(4));
    expect(writes).toEqual(["\x1b]9;fix the parser · inbox · 3 waiting\x07"]);
  });

  it("does not shout about an inbox that was already over the threshold at blur", () => {
    const { subject, writes } = notifier();
    subject.observe(inboxAt(4));
    subject.focusChanged("focus-out");
    subject.observe(inboxAt(5));
    expect(writes).toEqual([]);
  });

  it("keeps the two triggers on separate budgets within one stretch", () => {
    const { subject, writes } = notifier("bell");
    subject.observe(quiet);
    subject.focusChanged("focus-out");
    subject.observe(asking("fix the parser"));
    subject.observe({ ...asking("fix the parser"), inbox: 3 });
    subject.observe({ ...asking("fix the parser", "write the tests"), inbox: 9 });
    expect(writes).toEqual(["\x07", "\x07"]);
  });

  it("emits nothing at all when the transport is off", () => {
    const { subject, writes } = notifier("off");
    subject.observe(quiet);
    subject.focusChanged("focus-out");
    subject.observe(asking("fix the parser"));
    subject.observe(inboxAt(9));
    expect(writes).toEqual([]);
  });

  it("honors a custom inbox threshold", () => {
    const writes: string[] = [];
    const subject = new Notifier((bytes) => writes.push(bytes), "bell", 1);
    subject.observe(quiet);
    subject.focusChanged("focus-out");
    subject.observe(inboxAt(1));
    expect(writes).toEqual(["\x07"]);
  });
});
