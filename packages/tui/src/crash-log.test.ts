import { describe, expect, it } from "vitest";
import { crashLogFile, crashStormGate, doctorCommands } from "./crash-log.ts";

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
