import { describe, expect, it } from "vitest";
import { isWorkspacePattern, matchesAnyPattern } from "./watch.ts";

describe("a watch pattern", () => {
  it("stays relative and inside the workspace", () => {
    expect(["notes", "notes/**/*.md", "src/*.ts", "**"].every(isWorkspacePattern)).toBe(true);
    const escapes = ["../notes", "/etc/passwd", "C:/Users", "notes/../..", "notes\\a.md", ""];
    expect(escapes.some(isWorkspacePattern)).toBe(false);
  });

  it("matches a directory, a glob and a deep glob", () => {
    expect(matchesAnyPattern(["notes"], "notes/today.md")).toBe(true);
    expect(matchesAnyPattern(["src/*.ts"], "src/index.ts")).toBe(true);
    expect(matchesAnyPattern(["src/*.ts"], "src/deep/index.ts")).toBe(false);
    expect(matchesAnyPattern(["notes/**/*.md"], "notes/a/b/c.md")).toBe(true);
    expect(matchesAnyPattern(["notes/**/*.md"], "notes/c.md")).toBe(true);
    expect(matchesAnyPattern(["src/**"], "src/a/b.ts")).toBe(true);
    expect(matchesAnyPattern(["notes/?.md"], "notes/ab.md")).toBe(false);
    expect(matchesAnyPattern(["a.md"], "a-md")).toBe(false);
  });
});
