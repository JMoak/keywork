import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PermissionRule } from "../config/schema.ts";
import { GrantStore, GrantStoreError } from "./grant-store.ts";
import {
  grantAheadRefusal,
  grantCandidates,
  grantFromLabel,
  grantRefusal,
  ruleLabel,
  SessionGrants,
} from "./grants.ts";
import { layeredPolicy } from "./permissions.ts";

const bash = (command: string) => ({ command });
const allowBash = (resource: string): PermissionRule => ({
  action: "bash",
  resource,
  effect: "allow",
});

describe("grantCandidates", () => {
  it.each([
    ["git push origin main", ["git push *"]],
    ["git push", ["git push *"]],
    ["ls", ["ls *"]],
    ["cat README.md", ["cat *"]],
    ["npm test --silent", ["npm test *"]],
    ["npm run build", ["npm run *"]],
    ["./deploy.sh prod", ["./deploy.sh prod *"]],
    ["git add . && git commit -m wip", ["git add *", "git commit *"]],
    ["git status; git status --short", ["git status *"]],
    ["rg foo > out; ls", ["ls *"]],
    ["echo $(whoami)", []],
    ["*.sh", []],
  ])("derives the leading literal words of %s", (command, resources) => {
    expect(grantCandidates("bash", bash(command))).toEqual(resources.map(allowBash));
  });

  it.each([
    ["rm -rf dist", ["rm -rf dist"]],
    ["rm -r x", ["rm -r x"]],
    ["rmdir build", ["rmdir build"]],
    ["/bin/rm -f a.txt", ["/bin/rm -f a.txt"]],
    ["C:\\tools\\RM.EXE -rf out", ["C:\\tools\\RM.EXE -rf out"]],
    ["Remove-Item -Recurse out", ["Remove-Item -Recurse out"]],
    ["git branch -D topic", ["git branch -D topic"]],
    ["rm -rf *.log", []],
    ["npm run build && rm -rf dist", ["npm run *", "rm -rf dist"]],
  ])("remembers destructive %s only as its exact command", (command, resources) => {
    expect(grantCandidates("bash", bash(command))).toEqual(resources.map(allowBash));
  });

  it.each([
    "git push --force origin main",
    "git push -f origin main",
    "git push --force-with-lease",
    "git push origin +main",
    "git reset --hard HEAD~1",
    "git clean -fd",
    "git checkout -- .",
  ])("remembers nothing for %s", (command) => {
    const candidates = grantCandidates("bash", bash(command));
    expect(candidates).toEqual([]);
    expect(grantRefusal("bash", candidates)).toBe("nothing-to-remember");
  });

  it.each([
    ["git -C dir status", ["git -C dir status *"]],
    ["git --no-pager log -5", ["git --no-pager log *"]],
    ["git -c core.pager=cat log", ["git -c core.pager=cat log *"]],
    ["git -C dir push --force origin main", []],
    ["git -C dir reset --hard", []],
    ["git -C", []],
    ["git", []],
  ])("reads past git's global options in %s", (command, resources) => {
    expect(grantCandidates("bash", bash(command))).toEqual(resources.map(allowBash));
  });

  it.each([
    "git push --force origin main",
    "git push -f",
    "git push origin +main",
    "git -C dir push --force",
  ])("never lets a remembered git push * cover %s", (command) => {
    const policy = layeredPolicy([{ origin: "session", rules: [allowBash("git push *")] }]);
    expect(policy("bash", bash("git push origin dev"))).toEqual({
      effect: "allow",
      origin: "session",
    });
    expect(policy("bash", bash(command))).toBeUndefined();
  });

  it("disarms a wildcard grant over a destructive command, but not a configured rule", () => {
    const wildcard = [allowBash("rm -rf *")];
    const granted = layeredPolicy([{ origin: "workspace", rules: wildcard }]);
    expect(granted("bash", bash("rm -rf dist"))).toBeUndefined();
    const configured = layeredPolicy([{ origin: "user", rules: wildcard }]);
    expect(configured("bash", bash("rm -rf dist"))).toEqual({ effect: "allow", origin: "user" });
  });

  it("never lets a remembered rm cover a different target", () => {
    const policy = layeredPolicy([
      { origin: "session", rules: grantCandidates("bash", bash("rm -rf dist")) },
    ]);
    expect(policy("bash", bash("rm -rf dist"))).toEqual({ effect: "allow", origin: "session" });
    expect(policy("bash", bash("rm -rf build"))).toBeUndefined();
  });

  it("grants an MCP tool by its full name and never a write or edit", () => {
    expect(grantCandidates("github__create_issue", { title: "x" })).toEqual([
      { action: "github__create_issue", resource: "*", effect: "allow" },
    ]);
    expect(grantCandidates("write", { path: "a" })).toEqual([]);
    expect(grantCandidates("edit", { path: "a" })).toEqual([]);
    expect(grantCandidates("bash", {})).toEqual([]);
  });

  it("refuses writes beyond once and calls with nothing to remember", () => {
    expect(grantRefusal("write", [])).toBe("write-once");
    expect(grantRefusal("edit", [])).toBe("write-once");
    expect(grantRefusal("bash", [])).toBe("nothing-to-remember");
    expect(grantRefusal("bash", [allowBash("ls *")])).toBeUndefined();
  });

  it("derives rules that cover the call they came from", () => {
    for (const command of ["git push origin main", "npm run build && npm test"]) {
      const policy = layeredPolicy([
        { origin: "session", rules: grantCandidates("bash", bash(command)) },
      ]);
      expect(policy("bash", bash(command))).toEqual({ effect: "allow", origin: "session" });
    }
  });
});

describe("SessionGrants", () => {
  it("covers calls its remembered rules allow, and remembers nothing for writes", () => {
    const grants = new SessionGrants();
    expect(grants.covers("bash", bash("git push origin dev"))).toBe(false);
    expect(grants.remember("bash", bash("git push origin main"))).toEqual([
      allowBash("git push *"),
    ]);
    expect(grants.covers("bash", bash("git push origin dev"))).toBe(true);
    expect(grants.covers("bash", bash("git push origin dev; rm -rf ."))).toBe(false);
    expect(grants.remember("write", { path: "a" })).toEqual([]);
    expect(grants.covers("write", { path: "a" })).toBe(false);
    expect(grants.rules).toEqual([allowBash("git push *")]);
  });

  it("forgets one remembered rule so the call asks again", () => {
    const grants = new SessionGrants();
    grants.remember("bash", bash("git push origin main"));
    grants.remember("bash", bash("npm run build"));
    expect(grants.forget(allowBash("git push *"))).toBe(true);
    expect(grants.forget(allowBash("git push *"))).toBe(false);
    expect(grants.covers("bash", bash("git push origin dev"))).toBe(false);
    expect(grants.rules).toEqual([allowBash("npm run *")]);
  });
});

describe("grantAheadRefusal", () => {
  const allow = (action: string, resource: string): PermissionRule => ({
    action,
    resource,
    effect: "allow",
  });

  it("accepts exactly the rules an answered ask would record", () => {
    for (const resource of [
      "npm run *",
      "bun install *",
      "cargo test *",
      "git push *",
      "git -C dir status *",
      "ls *",
      "rm -rf dist",
      "git branch -D old",
    ]) {
      expect(grantAheadRefusal(allowBash(resource)), resource).toBeUndefined();
    }
    expect(grantAheadRefusal(allow("github__search", "*"))).toBeUndefined();
  });

  it("accepts a whole MCP server as one rule, and no other mcp pattern", () => {
    for (const server of ["github", "playwright", "my-docs", "jira_cloud"]) {
      expect(grantAheadRefusal(allow("mcp", `${server}__*`)), server).toBeUndefined();
    }
    for (const resource of ["*", "github__create_*", "git*__*", "__*", "a__b__*"]) {
      expect(grantAheadRefusal(allow("mcp", resource)), resource).toEqual({
        kind: "server-pattern",
      });
    }
    expect(grantAheadRefusal(allow("mcp", "github__search"))).toEqual({
      kind: "underivable",
      derived: [allow("github__search", "*")],
    });
  });

  it("matches a whole-server grant against that server's tools only, at either scope", () => {
    for (const origin of ["session", "workspace"] as const) {
      const policy = layeredPolicy([{ origin, rules: [allow("mcp", "github__*")] }]);
      expect(policy("github__search", {}), origin).toEqual({ effect: "allow", origin });
      expect(policy("github__merge_pull_request", {}), origin).toEqual({ effect: "allow", origin });
      expect(policy("githubx__search", {}), origin).toBeUndefined();
      expect(policy("jira__get_issue", {}), origin).toBeUndefined();
      expect(policy("bash", bash("github__search")), origin).toBeUndefined();
    }
  });

  it("refuses write, edit and every tool pattern", () => {
    expect(grantAheadRefusal(allow("write", "src/**"))).toEqual({ kind: "write-once" });
    expect(grantAheadRefusal(allow("edit", "*"))).toEqual({ kind: "write-once" });
    expect(grantAheadRefusal(allow("*", "*"))).toEqual({ kind: "tool-pattern" });
    expect(grantAheadRefusal(allow("playwright__*", "*"))).toEqual({ kind: "tool-pattern" });
  });

  it("refuses a wildcard over a delete and any grant of a command no answer remembers", () => {
    expect(grantAheadRefusal(allowBash("rm -rf *"))).toEqual({
      kind: "destructive",
      command: "rm -rf",
      remembered: "exact-command",
    });
    expect(grantAheadRefusal(allowBash("rm *.log"))).toMatchObject({ kind: "destructive" });
    expect(grantAheadRefusal(allowBash("git branch -D *"))).toMatchObject({
      kind: "destructive",
      remembered: "exact-command",
    });
    for (const command of ["git push --force", "git reset --hard", "git clean -fd"]) {
      expect(grantAheadRefusal(allowBash(`${command} *`)), command).toEqual({
        kind: "destructive",
        command,
        remembered: "nothing",
      });
      expect(grantAheadRefusal(allowBash(command)), command).toMatchObject({
        kind: "destructive",
      });
    }
  });

  it("refuses shapes an answer never derives, naming what it would derive instead", () => {
    expect(grantAheadRefusal(allowBash("npm run build *"))).toEqual({
      kind: "underivable",
      derived: [allowBash("npm run *")],
    });
    expect(grantAheadRefusal(allowBash("npm test"))).toEqual({
      kind: "underivable",
      derived: [allowBash("npm test *")],
    });
    expect(grantAheadRefusal(allowBash("git *"))).toEqual({ kind: "underivable", derived: [] });
    expect(grantAheadRefusal(allowBash("*"))).toEqual({ kind: "underivable", derived: [] });
    expect(grantAheadRefusal(allowBash("npm test && npm run lint"))).toEqual({
      kind: "underivable",
      derived: [allowBash("npm test *"), allowBash("npm run *")],
    });
    expect(grantAheadRefusal(allow("github__search", "repo:*"))).toEqual({
      kind: "underivable",
      derived: [allow("github__search", "*")],
    });
    expect(grantAheadRefusal(allow("read", "src/**"))).toEqual({
      kind: "underivable",
      derived: [],
    });
    expect(grantAheadRefusal(allow("mcp", "playwright"))).toEqual({
      kind: "underivable",
      derived: [],
    });
  });
});

describe("rule labels", () => {
  it("print a grant as one line and read it back the same way", () => {
    expect(ruleLabel(allowBash("git push *"))).toBe("bash git push *");
    expect(grantFromLabel("bash git push *")).toEqual(allowBash("git push *"));
    expect(grantFromLabel("  github__search   * ")).toEqual({
      action: "github__search",
      resource: "*",
      effect: "allow",
    });
    expect(grantFromLabel("bash")).toBeUndefined();
    expect(grantFromLabel("")).toBeUndefined();
  });
});

describe("GrantStore", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });
  const scratchFile = () => {
    dir = mkdtempSync(join(tmpdir(), "keywork-grants-"));
    return join(dir, "workspaces", "abc123", "permissions.json");
  };

  it("persists grants once each, privately, and revokes one at a time", () => {
    const file = scratchFile();
    const store = new GrantStore({ file });
    expect(store.rules()).toEqual([]);
    store.grant([allowBash("git push *"), allowBash("npm run *")]);
    store.grant([allowBash("git push *")]);
    const reopened = new GrantStore({ file });
    expect(reopened.rules()).toEqual([allowBash("git push *"), allowBash("npm run *")]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      rules: [allowBash("git push *"), allowBash("npm run *")],
    });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(reopened.revoke(allowBash("git push *"))).toBe(true);
    expect(reopened.revoke(allowBash("git push *"))).toBe(false);
    expect(new GrantStore({ file }).rules()).toEqual([allowBash("npm run *")]);
  });

  it.each([
    ["not json", "{"],
    ["no rules", "{}"],
    ["a deny", JSON.stringify({ rules: [{ action: "bash", resource: "*", effect: "deny" }] })],
    ["an extra key", JSON.stringify({ rules: [{ ...allowBash("ls *"), note: "x" }] })],
    ["a blank resource", JSON.stringify({ rules: [allowBash("")] })],
  ])("refuses a file with %s", (_, contents) => {
    const file = scratchFile();
    new GrantStore({ file }).grant([]);
    writeFileSync(file, contents);
    expect(() => new GrantStore({ file }).rules()).toThrow(GrantStoreError);
  });
});
