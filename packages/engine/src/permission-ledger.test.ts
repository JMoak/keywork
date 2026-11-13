import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolCallPart } from "./messages.ts";
import { memoryGrants, PermissionLedger } from "./permission-ledger.ts";
import { toolScope, withReadRoots } from "./tools/confine.ts";

let scratch: string;
let project: string;
let linked: string;
let readable: string;
let outside: string;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "keywork-trusted-reads-"));
  project = join(scratch, "project");
  linked = join(scratch, "linked");
  readable = join(scratch, "readable");
  outside = join(scratch, "outside");
  for (const dir of [project, join(project, "src"), linked, readable, outside]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(join(project, "README.md"), "readme\n");
  await writeFile(join(outside, "secret.txt"), "secret\n");
  symlinkSync(outside, join(project, "escape"), "junction");
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("the trusted read bundle under a ledger", () => {
  it.each([
    "cat README.md",
    "ls -la src",
    "ls",
    "grep -rn needle .",
    "find . -name '*.ts'",
    "head -n 20 src/index.ts",
    'cat "src/a b.ts"',
    "cat src\\index.ts",
    "git log --oneline -5",
    "git log --pretty=format:%h",
    "git show HEAD:src/index.ts",
    "echo hello",
    "pwd",
  ])("runs %s without an ask inside the workspace", (command) => {
    expect(rulingOn(command)).toEqual({ permission: "allow", gate: "trusted" });
  });

  it("reads an absolute path inside the workspace, a linked folder and a read root", () => {
    for (const path of [join(project, "README.md"), join(linked, "a.md"), join(readable, "b")]) {
      expect(rulingOn(`cat ${path}`)).toEqual({ permission: "allow", gate: "trusted" });
    }
  });

  it.each([
    ["a parent path", "cat ../outside/secret.txt"],
    ["a path that climbs out through the tree", "cat src/../../outside/secret.txt"],
    ["an absolute path elsewhere", () => `cat ${join(outside, "secret.txt")}`],
    ["the home folder", "cat ~/.ssh/id_rsa"],
    ["another user's home", "cat ~root/.ssh/id_rsa"],
    ["an environment variable", "cat $HOME/.ssh/id_rsa"],
    ["an MSYS drive path", "cat /c/Windows/win.ini"],
    ["a root path", "ls /"],
    ["a dot glob that can name the parent", "cat .*/outside/secret.txt"],
    ["a brace expansion", "cat {..,src}/outside/secret.txt"],
    ["a second operand outside", "cat README.md ../outside/secret.txt"],
    ["a quoted path outside", "cat '../outside/secret.txt'"],
    ["an escape the shell removes", "cat .\\./outside/secret.txt"],
    ["an attached option value", "grep -f../outside/secret.txt needle"],
    ["an assigned option value", "grep --file=../outside/secret.txt needle"],
    ["a git repository elsewhere", "git -C .. log"],
    ["git reading files outside the repository", "git diff --no-index ../outside/secret.txt x"],
    ["a PowerShell provider drive", "type env:USERPROFILE"],
    ["a provider-qualified path", "cat FileSystem::C:\\Windows\\win.ini"],
    ["a PowerShell parameter with an attached path", "ls -Path:.."],
    ["a link that leaves the workspace", "cat escape/secret.txt"],
  ])("asks before reading %s", (_reason, command) => {
    const asked = typeof command === "function" ? command() : command;
    expect(rulingOn(asked)).toBeUndefined();
  });

  it("still honours an explicit grant for a read outside the workspace", () => {
    const workspace = memoryGrants();
    workspace.grant([{ action: "bash", resource: "cat *", effect: "allow" }]);
    const ledger = trustedLedger(workspace);
    expect(ledger.resolverFor()(bashCall("cat ../outside/secret.txt"))).toEqual({
      permission: "allow",
      gate: "user",
      scope: "workspace",
    });
  });
});

function rulingOn(command: string) {
  return trustedLedger(memoryGrants()).resolverFor()(bashCall(command));
}

function trustedLedger(workspace: ReturnType<typeof memoryGrants>): PermissionLedger {
  return new PermissionLedger({
    trusted: true,
    workspace,
    root: project,
    readScope: withReadRoots(toolScope(project, [linked]), [readable]),
  });
}

function bashCall(command: string): ToolCallPart {
  return { type: "tool-call", callId: "c1", name: "bash", arguments: { command } };
}
