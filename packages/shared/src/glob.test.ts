import { describe, expect, it } from "vitest";
import {
  compileGlob,
  globMatches,
  globRules,
  mostSpecificMatch,
  mostSpecificRule,
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
