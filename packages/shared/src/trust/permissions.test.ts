import { describe, expect, it } from "vitest";
import { permissionPolicy } from "./permissions.ts";

const bash = (command: string) => ({ command });

describe("permissionPolicy", () => {
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
