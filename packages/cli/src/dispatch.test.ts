import { describe, expect, it } from "vitest";
import { dispatchCommand, nonInteractiveUsage, usage } from "./dispatch.ts";

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

  it("fails loudly for a bare invocation without a terminal", () => {
    expect(dispatchCommand([], false)).toEqual({ kind: "usage", exitCode: 1 });
    expect(dispatchCommand(["--json"], false)).toEqual({ kind: "usage", exitCode: 1 });
  });

  it("runs an explicit subcommand with or without a terminal", () => {
    expect(dispatchCommand(["chat", "--continue"], false)).toEqual({
      kind: "command",
      command: "chat",
      rest: ["--continue"],
    });
    expect(dispatchCommand(["chat"], true)).toEqual({ kind: "command", command: "chat", rest: [] });
    expect(dispatchCommand(["run", "hi", "--json"], false)).toEqual({
      kind: "command",
      command: "run",
      rest: ["hi", "--json"],
    });
    expect(dispatchCommand(["panes", "--fresh"], true)).toEqual({
      kind: "command",
      command: "panes",
      rest: ["--fresh"],
    });
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
