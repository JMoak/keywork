import { describe, expect, it } from "vitest";
import { crashLogFacts, crashLogFile, crashStormGate, doctorCommands } from "./crash-log.ts";

describe("doctorCommands", () => {
  function doctorProbe(exists: boolean, extras: { report?: string; posted?: boolean } = {}) {
    const opened: { path: string; atEnd: boolean }[] = [];
    const notices: string[] = [];
    const posts: string[] = [];
    const commands = doctorCommands({
      logFile: crashLogFile,
      exists: () => exists,
      openFile: (path, options) => opened.push({ path, atEnd: options?.atEnd === true }),
      notice: (text) => notices.push(text),
      post: (text) => {
        if (extras.posted === false) return false;
        posts.push(text);
        return true;
      },
      ...(extras.report !== undefined && { report: () => Promise.resolve(extras.report ?? "") }),
    });
    const named = (name: string) => commands.find((command) => command.name === name);
    return { doctor: named("doctor"), crashlog: named("crashlog"), opened, notices, posts };
  }

  it("posts the unified report into the focused conversation", async () => {
    const { doctor, opened, posts } = doctorProbe(true, { report: "keywork doctor" });
    doctor?.run();
    await Promise.resolve();
    expect(posts).toEqual(["keywork doctor"]);
    expect(opened).toEqual([]);
  });

  it("asks for a session when no conversation can take the report", async () => {
    const { doctor, notices } = doctorProbe(true, { report: "keywork doctor", posted: false });
    doctor?.run();
    await Promise.resolve();
    expect(notices).toEqual(["open a session to print the report into"]);
  });

  it("falls back to opening the crash log when no report port exists", () => {
    const { doctor, opened } = doctorProbe(true);
    doctor?.run();
    expect(opened).toEqual([{ path: crashLogFile, atEnd: true }]);
  });

  it("keeps the raw crash log one command away", () => {
    const { crashlog, opened } = doctorProbe(true, { report: "keywork doctor" });
    crashlog?.run();
    expect(opened).toEqual([{ path: crashLogFile, atEnd: true }]);
  });

  it("posts a calm notice when there is no crash log", () => {
    const { crashlog, opened, notices } = doctorProbe(false);
    crashlog?.run();
    expect(opened).toEqual([]);
    expect(notices).toEqual(["no crashes recorded · nothing to show"]);
  });
});

describe("crashLogFacts", () => {
  it("reports an absent log as zero entries at the path", () => {
    const facts = crashLogFacts("Z:/nowhere/tui-crash.log");
    expect(facts).toEqual({ path: "Z:/nowhere/tui-crash.log", entries: 0 });
  });
});

describe("crashStormGate", () => {
  it("trips only when crashes pile up inside the window", () => {
    const storm = crashStormGate();
    for (let at = 0; at < 19; at += 1) expect(storm(at)).toBe(false);
    expect(storm(19)).toBe(true);
  });

  it("forgets crashes older than the window", () => {
    const storm = crashStormGate();
    for (let at = 0; at < 19; at += 1) storm(at);
    expect(storm(10_000)).toBe(false);
  });
});
