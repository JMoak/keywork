import { describe, expect, it } from "vitest";
import {
  commandGlob,
  compileGlob,
  globMatches,
  globRules,
  mostSpecificMatch,
  mostSpecificRule,
  pathGlob,
} from "./glob.ts";

describe("globMatches", () => {
  it("matches the whole value with * spanning any run of characters", () => {
    expect(globMatches("git *", "git status")).toBe(true);
    expect(globMatches("git *", "git")).toBe(false);
    expect(globMatches("*", "")).toBe(true);
    expect(globMatches("gpt-5*", "gpt-5-mini")).toBe(true);
    expect(globMatches("gpt-5*", "my-gpt-5")).toBe(false);
  });

  it("lets * span newlines so a line break cannot dodge a pattern", () => {
    expect(globMatches("*rm -rf*", "git status\nrm -rf /")).toBe(true);
    expect(globMatches("git *", "git status\nrm -rf /")).toBe(true);
  });

  it("treats regex characters in patterns as literals", () => {
    expect(globMatches("a.b*", "a.b")).toBe(true);
    expect(globMatches("a.b*", "axb")).toBe(false);
    expect(globMatches("(x)|y", "(x)|y")).toBe(true);
    expect(globMatches("(x)|y", "y")).toBe(false);
  });

  it("counts literal characters as specificity", () => {
    expect(compileGlob("git status*").specificity).toBe(10);
    expect(compileGlob("*").specificity).toBe(0);
  });
});

describe("mostSpecificMatch", () => {
  it("picks the matching pattern with the most literal characters", () => {
    const patterns = { "*": "generic", "gpt-5*": "family", "gpt-5-mini": "exact" };
    expect(mostSpecificMatch(patterns, "gpt-5-mini")).toBe("exact");
    expect(mostSpecificMatch(patterns, "gpt-5-nano")).toBe("family");
    expect(mostSpecificMatch(patterns, "other")).toBe("generic");
  });

  it("breaks specificity ties in declaration order", () => {
    expect(mostSpecificMatch({ "a*c": "first", "ab*": "second" }, "abc")).toBe("first");
    expect(mostSpecificMatch({ "ab*": "second", "a*c": "first" }, "abc")).toBe("second");
  });

  it("returns nothing without patterns, a value, or a match", () => {
    expect(mostSpecificMatch(undefined, "x")).toBeUndefined();
    expect(mostSpecificMatch({ "*": 1 }, undefined)).toBeUndefined();
    expect(mostSpecificMatch({ "a*": 1 }, "b")).toBeUndefined();
  });
});

describe("mostSpecificRule", () => {
  it("ranks compiled rules the same way", () => {
    const rules = globRules({ "git *": "ask", "git status*": "allow" });
    expect(mostSpecificRule(rules)?.value).toBe("allow");
    expect(mostSpecificRule([])).toBeUndefined();
  });
});

describe("commandGlob", () => {
  it("lets a trailing space-star also match the bare command", () => {
    const glob = commandGlob("git status *");
    expect(glob.test("git status")).toBe(true);
    expect(glob.test("git status --short")).toBe(true);
    expect(glob.test("git statusx")).toBe(false);
  });

  it("behaves like a plain glob otherwise", () => {
    expect(commandGlob("git status*").test("git statusx")).toBe(true);
    expect(commandGlob("*rm -rf*").test("echo; rm -rf /")).toBe(true);
  });
});

describe("pathGlob", () => {
  it("lets **/ match zero or more directories", () => {
    const env = pathGlob("**/.env*");
    expect(env.test(".env")).toBe(true);
    expect(env.test(".env.local")).toBe(true);
    expect(env.test("apps/api/.env")).toBe(true);
    expect(env.test("apps/env")).toBe(false);
    expect(pathGlob("src/**/index.ts").test("src/index.ts")).toBe(true);
    expect(pathGlob("src/**/index.ts").test("src/a/b/index.ts")).toBe(true);
  });

  it("lets * span directories, the same as everywhere else", () => {
    expect(pathGlob("src/*").test("src/a/b.ts")).toBe(true);
    expect(pathGlob("*.md").test("docs/vision.md")).toBe(true);
  });

  it("reads backslashes in a pattern as separators", () => {
    expect(pathGlob("secrets\\**").test("secrets/key.pem")).toBe(true);
  });

  it("ignores case only when asked", () => {
    expect(pathGlob("**/.env*").test(".ENV")).toBe(false);
    expect(pathGlob("**/.env*", { caseInsensitive: true }).test(".ENV")).toBe(true);
  });
});
