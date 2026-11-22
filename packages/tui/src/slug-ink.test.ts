import { describe, expect, it } from "vitest";
import { slugParts, slugWords } from "./slug-ink.ts";

describe("the slug display grammar", () => {
  it("splits a slug into lit words and dim separators", () => {
    expect(slugParts("auth-retry-fix")).toEqual([
      { text: "auth", role: "word" },
      { text: "-", role: "separator" },
      { text: "retry", role: "word" },
      { text: "-", role: "separator" },
      { text: "fix", role: "word" },
    ]);
  });

  it("turns a slug into human words with no separators at all", () => {
    expect(slugWords("mcp-hardening:sleep-wake")).toBe("mcp hardening sleep wake");
    expect(slugWords("session-1")).toBe("session 1");
    expect(slugWords("solo")).toBe("solo");
  });

  it("reassembles to the stored slug, so identity is never lost", () => {
    for (const slug of ["a", "a-b", "arc:one-two", "x--y", ":lead", "trail-"]) {
      expect(
        slugParts(slug)
          .map((part) => part.text)
          .join(""),
      ).toBe(slug);
    }
  });
});
