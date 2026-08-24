import { describe, expect, it } from "vitest";
import { crashLogFile, crashStormGate, doctorCommand } from "./crash-log.ts";

describe("doctorCommand", () => {
  function doctorProbe(exists: boolean) {
    const opened: { path: string; atEnd: boolean }[] = [];
    const notices: string[] = [];
    const command = doctorCommand({
      logFile: crashLogFile,
      exists: () => exists,
      openFile: (path, options) => opened.push({ path, atEnd: options?.atEnd === true }),
      notice: (text) => notices.push(text),
    });
    return { command, opened, notices };
  }

  it("opens the crash log at its tail when crashes are recorded", () => {
    const { command, opened, notices } = doctorProbe(true);
    command.run();
    expect(opened).toEqual([{ path: crashLogFile, atEnd: true }]);
    expect(notices).toEqual([]);
  });

  it("posts a calm notice when there is no crash log", () => {
    const { command, opened, notices } = doctorProbe(false);
    command.run();
    expect(opened).toEqual([]);
    expect(notices).toEqual(["no crashes recorded · nothing to show"]);
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
