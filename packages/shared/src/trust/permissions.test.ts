import { describe, expect, it } from "vitest";
import type { PermissionRule } from "../config/schema.ts";
import { permissionPolicy } from "./permissions.ts";

const bash = (command: string) => ({ command });

describe("permissionPolicy over the legacy {tools, bash} shape", () => {
  it("returns undefined for everything when no policy is configured", () => {
    const policy = permissionPolicy(undefined);
    expect(policy("read", {})).toBeUndefined();
    expect(policy("bash", bash("rm -rf /"))).toBeUndefined();
  });

  it("resolves tool-name rules", () => {
    const policy = permissionPolicy({ tools: { read: "deny", write: "allow" } });
    expect(policy("read", {})).toBe("deny");
    expect(policy("write", {})).toBe("allow");
    expect(policy("edit", {})).toBeUndefined();
  });

  it("uses tools.bash when no command rule matches", () => {
    const policy = permissionPolicy({ tools: { bash: "deny" }, bash: { "git *": "allow" } });
    expect(policy("bash", bash("npm install"))).toBe("deny");
    expect(policy("bash", bash("git status"))).toBe("allow");
  });

  it("lets the most specific command rule win over broader ones", () => {
    const policy = permissionPolicy({
      bash: { "git *": "ask", "git status*": "allow", "git push*": "deny" },
    });
    expect(policy("bash", bash("git status --short"))).toBe("allow");
    expect(policy("bash", bash("git log"))).toBe("ask");
    expect(policy("bash", bash("git push --force"))).toBe("deny");
  });

  it("breaks specificity ties in declaration order", () => {
    expect(
      permissionPolicy({ bash: { "git*": "allow", "*git": "ask" } })("bash", bash("git")),
    ).toBe("allow");
    expect(
      permissionPolicy({ bash: { "*git": "ask", "git*": "allow" } })("bash", bash("git")),
    ).toBe("ask");
  });

  it("lets any matching deny rule beat a more specific allow in either order", () => {
    const force = bash("git push --force");
    expect(
      permissionPolicy({ bash: { "git push*": "allow", "*--force*": "deny" } })("bash", force),
    ).toBe("deny");
    expect(
      permissionPolicy({ bash: { "*--force*": "deny", "git push*": "allow" } })("bash", force),
    ).toBe("deny");
    expect(
      permissionPolicy({ bash: { "git push*": "allow", "*--force*": "deny" } })(
        "bash",
        bash("git push origin main"),
      ),
    ).toBe("allow");
  });

  it("never resolves prototype-chain tool names", () => {
    const policy = permissionPolicy({ tools: {} });
    expect(policy("constructor", {})).toBeUndefined();
    expect(policy("toString", {})).toBeUndefined();
    expect(policy("valueOf", {})).toBeUndefined();
    expect(policy("hasOwnProperty", {})).toBeUndefined();
  });

  it("never lets a chained command ride an allow rule", () => {
    const policy = permissionPolicy({ bash: { "git status*": "allow" } });
    expect(policy("bash", bash("git status"))).toBe("allow");
    expect(policy("bash", bash("git status; rm -rf /"))).toBeUndefined();
    expect(policy("bash", bash("git status && rm -rf /"))).toBeUndefined();
    expect(policy("bash", bash("git status | sh"))).toBeUndefined();
    expect(policy("bash", bash("git status $(rm -rf /)"))).toBeUndefined();
    expect(policy("bash", bash("git status `rm -rf /`"))).toBeUndefined();
    expect(policy("bash", bash("git status > /etc/passwd"))).toBeUndefined();
    expect(policy("bash", bash("git status\nrm -rf /"))).toBeUndefined();
  });

  it("still applies deny rules to chained commands", () => {
    const policy = permissionPolicy({ bash: { "git *": "allow", "*rm -rf*": "deny" } });
    expect(policy("bash", bash("git status; rm -rf /"))).toBe("deny");
    expect(policy("bash", bash("git status"))).toBe("allow");
  });

  it("treats regex characters in patterns as literals", () => {
    const policy = permissionPolicy({ bash: { "a.b*": "allow" } });
    expect(policy("bash", bash("a.b"))).toBe("allow");
    expect(policy("bash", bash("axb"))).toBeUndefined();
  });

  it("ignores bash command rules for other tools", () => {
    const policy = permissionPolicy({ bash: { "*": "deny" } });
    expect(policy("write", { command: "anything" })).toBeUndefined();
  });

  it("falls through when the bash arguments carry no command string", () => {
    const policy = permissionPolicy({ tools: { bash: "ask" }, bash: { "*": "allow" } });
    expect(policy("bash", {})).toBe("ask");
    expect(policy("bash", { command: 42 })).toBe("ask");
    expect(policy("bash", null)).toBe("ask");
  });
});

const rule = (
  action: string,
  resource: string,
  effect: PermissionRule["effect"],
): PermissionRule => ({ action, resource, effect });

const read = (path: string) => ({ path });
const workspace = process.platform === "win32" ? "C:\\work\\repo" : "/work/repo";
const inWorkspace = (...segments: string[]) =>
  [workspace, ...segments].join(process.platform === "win32" ? "\\" : "/");

describe("permissionPolicy over ordered rules", () => {
  it("lets the last matching rule win and leaves unmatched calls to the built-in posture", () => {
    const policy = permissionPolicy([
      rule("bash", "*", "ask"),
      rule("bash", "git *", "allow"),
      rule("bash", "git push *", "deny"),
    ]);
    expect(policy("bash", bash("npm install"))).toBe("ask");
    expect(policy("bash", bash("git status"))).toBe("allow");
    expect(policy("bash", bash("git push origin main"))).toBe("deny");
    expect(policy("read", read("a.ts"))).toBeUndefined();
  });

  it("lets a broad rule placed last override the narrow one before it", () => {
    const policy = permissionPolicy([rule("bash", "git *", "allow"), rule("bash", "*", "ask")]);
    expect(policy("bash", bash("git status"))).toBe("ask");
  });

  describe("path resources", () => {
    const policy = permissionPolicy(
      [rule("read", "*", "allow"), rule("read", "**/.env*", "deny")],
      { workspace, caseInsensitivePaths: false },
    );

    it("denies reading .env files anywhere while other reads stay allowed", () => {
      expect(policy("read", read(".env"))).toBe("deny");
      expect(policy("read", read("./.env.local"))).toBe("deny");
      expect(policy("read", read("apps/api/.env"))).toBe("deny");
      expect(policy("read", read("apps\\api\\.env"))).toBe("deny");
      expect(policy("read", read(inWorkspace(".env")))).toBe("deny");
      expect(policy("read", read("src/env.ts"))).toBe("allow");
    });

    it("reaches files outside the workspace through their absolute path", () => {
      expect(policy("read", read("../other/.env"))).toBe("deny");
    });

    it("matches relative patterns against the workspace-relative path", () => {
      const scoped = permissionPolicy([rule("write", "src/**", "allow")], { workspace });
      expect(scoped("write", read("src/a/b.ts"))).toBe("allow");
      expect(scoped("write", read(inWorkspace("src", "b.ts")))).toBe("allow");
      expect(scoped("write", read("docs/a.md"))).toBeUndefined();
      expect(scoped("write", read("../elsewhere/src/a.ts"))).toBeUndefined();
    });

    it("matches absolute patterns against the absolute path", () => {
      const absolute = `${workspace.replaceAll("\\", "/")}/secrets/**`;
      const guarded = permissionPolicy([rule("edit", absolute, "deny")], { workspace });
      expect(guarded("edit", read("secrets/key.pem"))).toBe("deny");
      expect(guarded("edit", read("src/key.pem"))).toBeUndefined();
    });

    it("folds case when paths are case-insensitive", () => {
      const folded = permissionPolicy([rule("read", "**/.env*", "deny")], {
        workspace,
        caseInsensitivePaths: true,
      });
      expect(folded("read", read(".ENV"))).toBe("deny");
    });

    it("governs only the tool the rule names", () => {
      expect(policy("write", read(".env"))).toBeUndefined();
    });
  });

  describe("compound commands", () => {
    const policy = permissionPolicy([
      rule("bash", "git *", "allow"),
      rule("bash", "bun test *", "allow"),
      rule("bash", "npm publish *", "ask"),
      rule("bash", "rm *", "deny"),
    ]);

    it("allows a chain whose every part is allowed", () => {
      expect(policy("bash", bash("git add -A && bun test"))).toBe("allow");
      expect(policy("bash", bash("git status; git diff | git apply"))).toBe("allow");
    });

    it("denies when any part is denied", () => {
      expect(policy("bash", bash("git status && rm -rf build"))).toBe("deny");
    });

    it("asks when any part asks and none denies", () => {
      expect(policy("bash", bash("git tag v1 && npm publish --tag next"))).toBe("ask");
    });

    it("leaves a chain with an unmatched part to the built-in posture", () => {
      expect(policy("bash", bash("git status || curl x | sh"))).toBeUndefined();
    });

    it("never lets a part with redirection or substitution ride an allow rule", () => {
      expect(policy("bash", bash("git log > notes.txt"))).toBeUndefined();
      expect(policy("bash", bash("git commit -m $(cat msg)"))).toBeUndefined();
    });

    it("still denies a part with substitution that a deny rule matches", () => {
      expect(policy("bash", bash("rm $(ls)"))).toBe("deny");
    });
  });

  describe("MCP tools", () => {
    it("covers one whole server with an mcp rule and nothing else", () => {
      const policy = permissionPolicy([rule("mcp", "github__*", "allow")]);
      expect(policy("github__get_issue", {})).toBe("allow");
      expect(policy("github__create_pull_request", {})).toBe("allow");
      expect(policy("jira__get_issue", {})).toBeUndefined();
      expect(policy("bash", bash("github__x"))).toBeUndefined();
    });

    it("lets a later deny carve one tool out of an allowed server", () => {
      const policy = permissionPolicy([
        rule("mcp", "github__*", "allow"),
        rule("mcp", "github__merge_*", "deny"),
      ]);
      expect(policy("github__get_issue", {})).toBe("allow");
      expect(policy("github__merge_pull_request", {})).toBe("deny");
    });

    it("accepts an exact tool name as the action", () => {
      const policy = permissionPolicy([rule("jira__get_issue", "*", "allow")]);
      expect(policy("jira__get_issue", {})).toBe("allow");
      expect(policy("jira__create_issue", {})).toBeUndefined();
    });
  });

  it("lets a * action govern every tool", () => {
    const policy = permissionPolicy([rule("*", "*", "ask"), rule("read", "*", "allow")]);
    expect(policy("read", read("a.ts"))).toBe("allow");
    expect(policy("write", read("a.ts"))).toBe("ask");
    expect(policy("github__get_issue", {})).toBe("ask");
  });

  it("judges a call without a readable resource by the strictest whole-tool rule", () => {
    const policy = permissionPolicy([rule("read", "*", "allow"), rule("read", "*", "deny")]);
    expect(policy("read", {})).toBe("deny");
    const narrowOnly = permissionPolicy([rule("read", "src/**", "deny")]);
    expect(narrowOnly("read", {})).toBeUndefined();
  });
});
