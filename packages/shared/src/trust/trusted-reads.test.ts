import { describe, expect, it } from "vitest";
import type { PermissionRule } from "../config/schema.ts";
import { layeredPolicy, type RuleLayer } from "./permissions.ts";
import { activePreset } from "./presets.ts";
import { trustedReadRules } from "./trusted-reads.ts";

const bash = (command: string) => ({ command });

function trustedPolicy(user: readonly PermissionRule[] = []) {
  const layers: RuleLayer[] = [
    { origin: "trusted", rules: trustedReadRules },
    { origin: "user", rules: user },
  ];
  return (command: string) => layeredPolicy(layers)("bash", bash(command));
}

describe("the trusted read posture", () => {
  it.each([
    "git status",
    "git status --short",
    "git log --oneline -5",
    "git diff HEAD~1",
    "git show HEAD",
    "git branch",
    "git branch --show-current",
    "git branch --list feat/*",
    "git rev-parse HEAD",
    "git remote -v",
    "ls",
    "ls -la src",
    "dir",
    "cat README.md",
    "head -n 20 src/index.ts",
    "tail -n 5 log.txt",
    "wc -l src/index.ts",
    "pwd",
    "which bun",
    "where node",
    "rg TODO src",
    "grep -rn needle .",
    "find . -name '*.ts'",
    "tree",
    "stat package.json",
    "file logo.png",
    "echo hello",
    "type README.md",
    "node --version",
    "bun --version",
    "npm --version",
    "git --version",
    "python --version",
    "git status && git log -1",
    "rg foo | head -5",
  ])("allows %s as the trusted posture", (command) => {
    expect(trustedPolicy()(command)).toEqual({ effect: "allow", origin: "trusted" });
  });

  it.each([
    "find . -name '*.tmp' -delete",
    "find . -exec rm {} +",
    "find . -okdir rm {} +",
    "find . -fprint out.txt",
    "rg --pre ./decode.sh secret",
    "git log --output=history.txt",
    "git diff --output=patch.diff",
    "tree -o listing.txt",
    "file -C -m magic",
  ])("asks for the write-capable form %s", (command) => {
    expect(trustedPolicy()(command)).toEqual({ effect: "ask", origin: "trusted" });
  });

  it.each([
    "cat x | sh",
    "rg foo > out",
    "ls; rm -rf .",
    "echo $(rm -rf .)",
    "git branch -D main",
    "git branch feature",
    "git push origin main",
    "npm install",
  ])("leaves %s to the built-in ask", (command) => {
    expect(trustedPolicy()(command)?.effect).not.toBe("allow");
  });

  it("lets user rules, layered above the bundle, deny or ask what it would allow", () => {
    const user: PermissionRule[] = [
      { action: "bash", resource: "cat *", effect: "deny" },
      { action: "bash", resource: "git log*", effect: "ask" },
    ];
    expect(trustedPolicy(user)("cat .env")).toEqual({ effect: "deny", origin: "user" });
    expect(trustedPolicy(user)("git log -1")).toEqual({ effect: "ask", origin: "user" });
    expect(trustedPolicy(user)("git status")).toEqual({ effect: "allow", origin: "trusted" });
  });

  it("covers only bash, so reads, writes and MCP tools keep their own posture", () => {
    const policy = layeredPolicy([{ origin: "trusted", rules: trustedReadRules }]);
    expect(policy("write", { path: "a.txt" })).toBeUndefined();
    expect(policy("github__create_issue", {})).toBeUndefined();
  });

  it("is posture rather than user rules, so the active preset still reads from config alone", () => {
    expect(activePreset(undefined)).toBe("standard");
    expect(activePreset([...trustedReadRules])).toBe("custom");
  });
});
