import { describe, expect, it } from "vitest";
import { insertedMention, mentionAt, rankMentions } from "./mention-completer.ts";

const files = [
  "README.md",
  "packages/tui/src/app.ts",
  "packages/tui/src/app-core.ts",
  "packages/engine/src/agent.ts",
  "packages/tui/src/prompt-editor.ts",
  ".github/workflows/ci.yml",
  "docs/my notes.md",
].map((relative) => ({ relative }));

describe("mentionAt", () => {
  it("finds the token the cursor is typing after an @", () => {
    expect(mentionAt("look at @pack", 13)).toEqual({ start: 8, end: 13, query: "pack" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, end: 1, query: "" });
  });

  it("spans the whole path when the cursor sits inside it", () => {
    expect(mentionAt("see @src/app.ts now", 7)).toEqual({ start: 4, end: 15, query: "sr" });
  });

  it("ignores an @ glued to a word, like an email address", () => {
    expect(mentionAt("mail me@host", 12)).toBeUndefined();
    expect(mentionAt("no mention here", 15)).toBeUndefined();
  });

  it("ends at whitespace", () => {
    expect(mentionAt("@app.ts and more", 16)).toBeUndefined();
  });
});

describe("rankMentions", () => {
  it("fuzzy matches and puts file-name hits first", () => {
    const ranked = rankMentions("app", files, 5);
    expect(ranked.slice(0, 2)).toEqual(["packages/tui/src/app.ts", "packages/tui/src/app-core.ts"]);
  });

  it("matches across the path when the query has a slash", () => {
    expect(rankMentions("engine/ag", files, 5)).toEqual(["packages/engine/src/agent.ts"]);
  });

  it("hides dot paths until the query reaches for them, like the browser", () => {
    expect(rankMentions("ci", files, 5)).not.toContain(".github/workflows/ci.yml");
    expect(rankMentions(".gi", files, 5)).toContain(".github/workflows/ci.yml");
  });

  it("leaves out paths the @file grammar cannot carry", () => {
    expect(rankMentions("notes", files, 5)).toEqual([]);
  });

  it("offers shallow files first for a bare @ and caps the list", () => {
    const ranked = rankMentions("", files, 3);
    expect(ranked).toHaveLength(3);
    expect(ranked[0]).toBe("README.md");
  });
});

describe("insertedMention", () => {
  it("writes the canonical path with a trailing space so typing carries on", () => {
    expect(insertedMention("packages/tui/src/app.ts")).toBe("@packages/tui/src/app.ts ");
  });
});
