import { describe, expect, it } from "vitest";
import type { ToolCallPart } from "../../messages.ts";
import { PermissionLedger } from "../../permission-ledger.ts";
import { meshWorkspace } from "./gate.ts";
import { grantRules, subjectRules } from "./rules.ts";

function call(name: string, args: unknown): ToolCallPart {
  return { type: "tool-call", callId: "c1", name, arguments: args };
}

function rulingUnder(caps: Parameters<typeof grantRules>[0]["caps"], probe: ToolCallPart) {
  const rules = grantRules({ caps });
  const ledger = new PermissionLedger({
    trusted: false,
    root: "/srv/work",
    workspace: meshWorkspace(() => rules),
  });
  return ledger.resolverFor()(probe);
}

describe("grantRules", () => {
  it("renders files and exec caps into allow rules and nothing for screen caps", () => {
    expect(
      grantRules({
        caps: [
          { kind: "files:read", paths: ["src/**"] },
          { kind: "files:write", paths: ["out/**"] },
          { kind: "exec", commands: ["echo", "git status"] },
          { kind: "screen:view" },
          { kind: "clipboard" },
        ],
      }),
    ).toEqual([
      { action: "read", resource: "src/**", effect: "allow" },
      { action: "write", resource: "out/**", effect: "allow" },
      { action: "edit", resource: "out/**", effect: "allow" },
      { action: "bash", resource: "echo *", effect: "allow" },
      { action: "bash", resource: "git status *", effect: "allow" },
    ]);
  });

  it("merges a subject's grants without repeating a rule", () => {
    const exec = { caps: [{ kind: "exec" as const, commands: ["echo"] }] };
    expect(subjectRules([exec, exec])).toEqual([
      { action: "bash", resource: "echo *", effect: "allow" },
    ]);
  });

  it("lets the ordinary gate allow what the grant covers and nothing more", () => {
    const exec = [{ kind: "exec" as const, commands: ["echo"] }];
    expect(rulingUnder(exec, call("bash", { command: "echo hi" }))).toMatchObject({
      permission: "allow",
    });
    expect(rulingUnder(exec, call("bash", { command: "echo" }))).toMatchObject({
      permission: "allow",
    });
    expect(rulingUnder(exec, call("bash", { command: "ls" }))).toBeUndefined();
    expect(rulingUnder(exec, call("bash", { command: "echo hi; rm -rf /" }))).not.toMatchObject({
      permission: "allow",
    });
    expect(
      rulingUnder(exec, call("bash", { command: "echo $(cat /etc/passwd)" })),
    ).not.toMatchObject({
      permission: "allow",
    });
    const read = [{ kind: "files:read" as const, paths: ["src/**"] }];
    expect(rulingUnder(read, call("read", { path: "src/a/b.ts" }))).toMatchObject({
      permission: "allow",
    });
    expect(rulingUnder(read, call("read", { path: "secrets/key" }))).toBeUndefined();
  });
});
