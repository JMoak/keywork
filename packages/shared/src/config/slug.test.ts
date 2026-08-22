import { describe, expect, it } from "vitest";
import { isSlug, slugProblem } from "./slug.ts";

describe("the slug grammar shared by arcs and workspaces", () => {
  it("accepts lowercase words, digits, and inner hyphens", () => {
    for (const slug of ["a", "dock-v2", "frontend-revamp", "x1", "a".repeat(64)]) {
      expect(isSlug(slug)).toBe(true);
    }
  });

  it("rejects case, spaces, edge hyphens, emptiness, and length overflow with a reason", () => {
    for (const slug of ["Dock", "dock v2", "-dock", "dock-", "", "a".repeat(65), "dock_v2"]) {
      expect(slugProblem(slug)).toContain("lowercase letters, digits, and inner hyphens");
    }
  });

  it("rejects Windows device names, which would never survive as directories", () => {
    expect(slugProblem("con")).toBe("reserved device name");
    expect(slugProblem("com1")).toBe("reserved device name");
    expect(isSlug("console")).toBe(true);
  });
});
