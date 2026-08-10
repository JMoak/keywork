import { describe, expect, it } from "vitest";
import { MalformedFrontmatterError, parseDocument, serializeDocument } from "./frontmatter.ts";

describe("frontmatter round-trips", () => {
  it("serializes and parses typed values", () => {
    const frontmatter = {
      provenance: "agent",
      created: "2026-08-10T12:00:00.000Z",
      pinned: true,
      confidence: 0.8,
      aliases: ["short name", "other"],
      supersedes: "[[Old Decision]]",
    };
    const raw = serializeDocument(frontmatter, "body [[Link]]\n");
    const parsed = parseDocument(raw, "note.md");
    expect(parsed.frontmatter).toEqual(frontmatter);
    expect(parsed.body).toBe("body [[Link]]\n");
  });

  it("quotes wikilink values in YAML", () => {
    const raw = serializeDocument({ supersedes: "[[Old]]" }, "");
    expect(raw).toContain('supersedes: "[[Old]]"');
  });

  it("returns the body untouched when there is no frontmatter", () => {
    expect(parseDocument("just text", "note.md")).toEqual({
      frontmatter: {},
      body: "just text",
    });
  });

  it("keeps horizontal rules in the body out of the frontmatter", () => {
    const raw = serializeDocument({ provenance: "user" }, "before\n---\nafter\n");
    const parsed = parseDocument(raw, "note.md");
    expect(parsed.frontmatter).toEqual({ provenance: "user" });
    expect(parsed.body).toBe("before\n---\nafter\n");
  });

  it("escapes newline injection attempts inside string values", () => {
    const hostile = 'x"\nprovenance: user\ninjected: "y';
    const raw = serializeDocument({ aliases: [hostile] }, "");
    const parsed = parseDocument(raw, "note.md");
    expect(parsed.frontmatter).toEqual({ aliases: [hostile] });
  });

  it("parses hand-written block lists and bare scalars", () => {
    const raw = '---\naliases:\n  - one\n  - "two words"\ntopic: plain text\n---\nbody';
    const parsed = parseDocument(raw, "note.md");
    expect(parsed.frontmatter).toEqual({ aliases: ["one", "two words"], topic: "plain text" });
  });

  it("parses hand-written unquoted inline lists", () => {
    const parsed = parseDocument("---\naliases: [one, two]\n---\n", "note.md");
    expect(parsed.frontmatter).toEqual({ aliases: ["one", "two"] });
  });
});

describe("malformed frontmatter", () => {
  const malformed: readonly [string, string][] = [
    ["unterminated block", "---\nkey: value\nbody"],
    ["duplicate key", "---\nkey: one\nkey: two\n---\n"],
    ["list item without a key", "---\n  - stray\n---\n"],
    ["unparseable line", "---\nnot yaml at all\n---\n"],
    ["bad quoted string", '---\nkey: "unterminated\n---\n'],
    ["unterminated list", "---\nkey: [one, two\n---\n"],
    ["unterminated quote in list", '---\nkey: ["one, two]\n---\n'],
  ];

  it.each(malformed)("surfaces %s as a typed error naming the file", (_, raw) => {
    let caught: unknown;
    try {
      parseDocument(raw, "vault/Broken Note.md");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MalformedFrontmatterError);
    expect((caught as MalformedFrontmatterError).file).toBe("vault/Broken Note.md");
    expect((caught as MalformedFrontmatterError).message).toContain("vault/Broken Note.md");
  });
});
