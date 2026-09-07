import type { PermissionDecision, Tool, ToolCallPart, ToolGuard } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import {
  guardedShellEscape,
  shellEscapeCall,
  shellEscapeCommand,
  shellEscapeTranscript,
} from "./shell-escape.ts";

function bashStub(runs: string[], mutates = true): Tool {
  return {
    name: "bash",
    description: "stub",
    parameters: { type: "object" },
    mutates,
    execute: async (args) => {
      const { command } = args as { command: string };
      runs.push(command);
      return `ran ${command}`;
    },
  };
}

const call = shellEscapeCall("echo hi", 1);

describe("shellEscapeCommand", () => {
  it("strips the bang from a command", () => {
    expect(shellEscapeCommand("!echo hi")).toBe("echo hi");
    expect(shellEscapeCommand("!ls -la")).toBe("ls -la");
  });

  it("leaves a bare bang and a bang followed by whitespace as prompt text", () => {
    expect(shellEscapeCommand("!")).toBeUndefined();
    expect(shellEscapeCommand("! ")).toBeUndefined();
    expect(shellEscapeCommand("! important note")).toBeUndefined();
    expect(shellEscapeCommand("!\tcmd")).toBeUndefined();
    expect(shellEscapeCommand("hello!")).toBeUndefined();
  });

  it("names the call as a bash tool call with a user-shell id", () => {
    expect(call).toEqual({
      type: "tool-call",
      callId: "user-shell-1",
      name: "bash",
      arguments: { command: "echo hi" },
    });
  });

  it("renders the transcript as a prompt line followed by trimmed output", () => {
    expect(shellEscapeTranscript("echo hi", "hi\n\n")).toBe("$ echo hi\nhi");
    expect(shellEscapeTranscript("true", "")).toBe("$ true");
  });
});

describe("guardedShellEscape", () => {
  it("asks the guard before running a mutating tool when policy is silent", async () => {
    const runs: string[] = [];
    const asked: ToolCallPart[] = [];
    const decisions: PermissionDecision[] = [];
    const guard: ToolGuard = {
      confirm: async (asking) => {
        asked.push(asking);
        return true;
      },
    };
    const port = guardedShellEscape({
      tools: () => [bashStub(runs)],
      guard,
      onDecision: (decision) => decisions.push(decision),
    });

    const result = await port.run(call);

    expect(asked).toEqual([call]);
    expect(runs).toEqual(["echo hi"]);
    expect(result).toEqual({ output: "ran echo hi", isError: false });
    expect(decisions).toEqual([
      { tool: "bash", callId: "user-shell-1", verdict: "granted", gate: "user" },
    ]);
  });

  it("refuses when the guard declines and never runs the command", async () => {
    const runs: string[] = [];
    const port = guardedShellEscape({
      tools: () => [bashStub(runs)],
      guard: { confirm: async () => false },
    });

    expect(await port.run(call)).toEqual({ output: "declined by user", isError: true });
    expect(runs).toEqual([]);
  });

  it("applies the policy deny rule before anyone is asked", async () => {
    const runs: string[] = [];
    let asked = 0;
    const port = guardedShellEscape({
      tools: () => [bashStub(runs)],
      guard: {
        confirm: async () => {
          asked += 1;
          return true;
        },
      },
      permissions: (asking) =>
        /^rm -rf/.test((asking.arguments as { command: string }).command) ? "deny" : "allow",
    });

    const denied = await port.run(shellEscapeCall("rm -rf /", 2));
    const allowed = await port.run(call);

    expect(denied).toEqual({ output: "denied by permission policy", isError: true });
    expect(allowed.isError).toBe(false);
    expect(asked).toBe(0);
    expect(runs).toEqual(["echo hi"]);
  });

  it("checkpoints through the guard before a mutating run, as the agent does", async () => {
    const order: string[] = [];
    const port = guardedShellEscape({
      tools: () => [bashStub(order)],
      guard: {
        beforeMutation: async () => {
          order.push("checkpoint");
        },
      },
      permissions: () => "allow",
    });

    await port.run(call);

    expect(order).toEqual(["checkpoint", "echo hi"]);
  });

  it("reports a missing bash tool and a throwing tool as failed results", async () => {
    const missing = guardedShellEscape({ tools: () => [], guard: {} });
    const throwing = guardedShellEscape({
      tools: () => [
        {
          name: "bash",
          description: "explodes",
          parameters: { type: "object" },
          execute: async () => {
            throw new Error("boom");
          },
        },
      ],
      guard: {},
    });

    expect(await missing.run(call)).toEqual({
      output: "no bash tool in this session",
      isError: true,
    });
    expect(await throwing.run(call)).toEqual({ output: "boom", isError: true });
  });
});
