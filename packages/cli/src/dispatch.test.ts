import { describe, expect, it } from "vitest";
import {
  dispatchCommand,
  exitCodes,
  nonInteractiveUsage,
  usage,
  withoutTerminal,
} from "./dispatch.ts";

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

  it("refuses a bare invocation without a terminal as a usage error", () => {
    expect(dispatchCommand([], false)).toEqual({
      kind: "usage",
      exitCode: exitCodes.usage,
      reason: "no command given and no terminal attached",
    });
    expect(dispatchCommand(["--json"], false).kind).toBe("usage");
  });

  it("refuses the terminal-only commands without a terminal, naming the command", () => {
    expect(dispatchCommand(["panes"], false)).toEqual({
      kind: "usage",
      exitCode: exitCodes.usage,
      reason: "panes needs a terminal",
    });
    expect(dispatchCommand(["chat", "--continue"], false)).toEqual({
      kind: "usage",
      exitCode: exitCodes.usage,
      reason: "chat needs a terminal",
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

  it("answers --version before anything else, terminal or not", () => {
    expect(dispatchCommand(["--version"], false)).toEqual({ kind: "version" });
    expect(dispatchCommand(["-V"], true)).toEqual({ kind: "version" });
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

  it("prints the exit codes in usage", () => {
    expect(usage).toContain(
      "0 completed · 1 failed · 2 usage · 3 unresolved · 4 denied · 130 interrupted",
    );
  });
});

describe("usage", () => {
  it("leads with panes and demotes chat to the smoke-harness tail", () => {
    const lines = usage.split("\n");
    const panesLine = lines.findIndex((line) => line.includes("keywork [panes]"));
    const chatLine = lines.findIndex((line) => line.includes("keywork chat"));
    expect(panesLine).toBeGreaterThan(-1);
    expect(chatLine).toBeGreaterThan(panesLine);
    expect(usage).toContain("engine smoke REPL (debug)");
  });

  it("points non-interactive callers at run", () => {
    expect(nonInteractiveUsage).toContain('keywork run "<prompt>" [--json]');
    expect(nonInteractiveUsage).toContain(usage);
  });
});
