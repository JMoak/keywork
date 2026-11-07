import { describe, expect, it } from "vitest";
import { askFactsOf, askTextLimit, isOneWayDoorClass, oneWayDoorClass } from "./facts.ts";
import { askFor, bashAsk } from "./testing.ts";

describe("askFactsOf", () => {
  it("normalizes a command to the rule a session answer would record", () => {
    const facts = askFactsOf(bashAsk("npm test --silent"));
    expect(facts).toMatchObject({
      tool: "bash",
      askedBecause: "default",
      rules: ["bash npm test *"],
      ruleClass: "bash npm test *",
      destructive: false,
      opaque: false,
      commandParts: 1,
      askText: "npm test --silent",
      truncated: false,
    });
  });

  it("classes a compound command by its sorted rules, so part order never splits a class", () => {
    const forward = askFactsOf(bashAsk("git add . && git commit -m wip"));
    const backward = askFactsOf(bashAsk("git commit -m wip && git add ."));
    expect(forward.ruleClass).toBe("bash git add * + bash git commit *");
    expect(backward.ruleClass).toBe(forward.ruleClass);
  });

  it("puts every destructive form in K9's sense in the one-way door class", () => {
    for (const command of ["rm -rf dist", "git push --force", "git reset --hard", "ls && rm x"]) {
      const facts = askFactsOf(bashAsk(command));
      expect(facts.destructive, command).toBe(true);
      expect(facts.ruleClass, command).toBe(oneWayDoorClass);
    }
  });

  it("marks a command keywork cannot see through as opaque", () => {
    const facts = askFactsOf(bashAsk("rg foo > out.txt"));
    expect(facts.opaque).toBe(true);
    expect(facts.ruleClass).toBe("bash (opaque)");
  });

  it("places a path against the session's working directory", () => {
    const cwd = process.platform === "win32" ? "C:\\work\\repo" : "/work/repo";
    expect(askFactsOf(askFor("write", { path: "src/a.ts", content: "x" }), { cwd })).toMatchObject({
      ruleClass: "write",
      insideWorkspace: true,
      askText: "src/a.ts",
    });
    const outside = askFactsOf(askFor("edit", { path: "../elsewhere/b.ts" }), { cwd });
    expect(outside.insideWorkspace).toBe(false);
  });

  it("falls back to the preview's path, and says unknown when nothing places the path", () => {
    const previewed = {
      ...askFor("write", { path: "a.ts" }),
      preview: { path: "a.ts", before: null, after: "x" },
    };
    expect(askFactsOf(previewed).insideWorkspace).toBe(true);
    expect(askFactsOf(askFor("write", { path: "a.ts" })).insideWorkspace).toBe("unknown");
  });

  it("keeps an MCP tool's arguments as JSON with secret fields hidden", () => {
    const facts = askFactsOf(askFor("github__create_issue", { title: "bug", token: "abc123" }));
    expect(facts.ruleClass).toBe("github__create_issue *");
    expect(facts.askText).toBe('{"title":"bug","token":"[redacted]"}');
  });

  it("scrubs secrets from the ask text before anything can read it", () => {
    const facts = askFactsOf(bashAsk("curl -H 'Bearer abcdefgh12345' https://x"), {
      secrets: [{ name: "deploy", value: "hunter2hunter2" }],
    });
    expect(facts.askText).not.toContain("abcdefgh12345");
    const named = askFactsOf(bashAsk("echo hunter2hunter2"), {
      secrets: [{ name: "deploy", value: "hunter2hunter2" }],
    });
    expect(named.askText).toBe("echo ‹redacted:deploy›");
  });

  it("flags an ask text longer than the limit as truncated", () => {
    const long = askFactsOf(bashAsk(`echo ${"a".repeat(askTextLimit)}`));
    expect(long.truncated).toBe(true);
  });
});

describe("isOneWayDoorClass", () => {
  it("recognizes the class and any rule naming a destructive command", () => {
    expect(isOneWayDoorClass(oneWayDoorClass)).toBe(true);
    expect(isOneWayDoorClass("bash rm -rf dist")).toBe(true);
    expect(isOneWayDoorClass("bash git push --force *")).toBe(true);
    expect(isOneWayDoorClass("bash npm test * + bash git branch -D old")).toBe(true);
    expect(isOneWayDoorClass("bash npm test *")).toBe(false);
    expect(isOneWayDoorClass("write")).toBe(false);
  });
});
