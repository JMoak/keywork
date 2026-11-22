import { describe, expect, it } from "vitest";
import { dispatchCommand, exitCodes, usage, withoutTerminal } from "./dispatch.ts";

describe("dispatchCommand", () => {
  it("boots panes for a bare invocation in a terminal", () => {
    expect(dispatchCommand([], true)).toEqual({ kind: "command", command: "panes", rest: [] });
  });

  it("forwards bare flags to panes in a terminal", () => {
    expect(dispatchCommand(["--fresh"], true)).toEqual({
      kind: "command",
      command: "panes",
      rest: ["--fresh"],
    });
  });

  it("runs the headless-capable commands with or without a terminal", () => {
    expect(dispatchCommand(["run", "hi", "--json"], false)).toEqual({
      kind: "command",
      command: "run",
      rest: ["hi", "--json"],
    });
    expect(dispatchCommand(["sessions", "list"], false)).toEqual({
      kind: "command",
      command: "sessions",
      rest: ["list"],
    });
    expect(dispatchCommand(["chat"], true)).toEqual({ kind: "command", command: "chat", rest: [] });
    expect(dispatchCommand(["panes", "--fresh"], true)).toEqual({
      kind: "command",
      command: "panes",
      rest: ["--fresh"],
    });
  });

  it("answers --help, -h, and the help word before anything else, terminal or not", () => {
    expect(dispatchCommand(["--help"], false)).toEqual({ kind: "help" });
    expect(dispatchCommand(["-h"], true)).toEqual({ kind: "help" });
    expect(dispatchCommand(["help"], false)).toEqual({ kind: "help" });
  });

  it("refuses unknown commands as usage errors, pointing at --help", () => {
    expect(dispatchCommand(["frobnicate"], false)).toEqual({
      kind: "usage",
      exitCode: exitCodes.usage,
      reason: 'unknown command "frobnicate" · keywork --help lists the commands',
    });
    expect(dispatchCommand(["constructor"], true).kind).toBe("usage");
  });
});

describe("the exit contract", () => {
  it("pins one stable code per exit class", () => {
    expect(exitCodes).toEqual({
      completed: 0,
      failed: 1,
      usage: 2,
      unresolved: 3,
      denied: 4,
      interrupted: 130,
    });
  });

  it("documents every usage command's posture without a terminal", () => {
    const commands = [...usage.matchAll(/^ {2}keywork (?:\[(\w+)\]|(\w+)) /gm)]
      .map(([, optional, named]) => optional ?? named ?? "")
      .filter((command) => command !== "" && !command.startsWith("-"));
    for (const command of commands) expect(withoutTerminal).toHaveProperty(command);
  });
});
