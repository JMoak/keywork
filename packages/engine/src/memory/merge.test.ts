import { describe, expect, it } from "vitest";
import {
  conflictMarkers,
  isAppendOnlyPath,
  mergeFrontmatter,
  mergeText,
  mergeVaultFile,
  splitConflictMarkers,
} from "./merge.ts";

function note(frontmatter: string, body: string): string {
  return `---\n${frontmatter}\n---\n${body}`;
}

describe("merge driver: notes", () => {
  it("takes the only side that changed", () => {
    const base = note('provenance: "agent"', "one\n");
    const outcome = mergeVaultFile("Note.md", {
      base,
      ours: base,
      theirs: note('provenance: "agent"', "two\n"),
    });
    expect(outcome).toEqual({ merged: true, content: note('provenance: "agent"', "two\n") });
  });

  it("resolves derived frontmatter deterministically and unions both appends", () => {
    const base = note('provenance: "agent"\nusefulness: 0.2\naliases: ["a"]', "base\n");
    const ours = note('provenance: "agent"\nusefulness: 0.5\naliases: ["a", "b"]', "base\nours\n");
    const theirs = note(
      'provenance: "agent"\nusefulness: 0.3\naliases: ["a", "c"]\npinned: true',
      "base\ntheirs\n",
    );
    expect(mergeVaultFile("Note.md", { base, ours, theirs })).toEqual({
      merged: true,
      content: note(
        'provenance: "agent"\nusefulness: 0.5\naliases: ["a", "b", "c"]\npinned: true',
        "base\nours\ntheirs\n",
      ),
    });
  });

  it("keeps the later drift stamp and ours for supersession links", () => {
    const base = note('provenance: "agent"', "x\n");
    const ours = note(
      'provenance: "agent"\ndrift:\n  verdict: "hold"\n  at: "2026-08-10T09:00:00.000Z"\n  against: "a"\nsuperseded_by: "[[Ours]]"',
      "x\n",
    );
    const theirs = note(
      'provenance: "agent"\ndrift:\n  verdict: "stale"\n  at: "2026-08-11T09:00:00.000Z"\n  against: "b"\nsuperseded_by: "[[Theirs]]"',
      "x\n",
    );
    const outcome = mergeVaultFile("Note.md", { base, ours, theirs });
    expect(outcome.merged).toBe(true);
    expect(outcome.content).toContain('verdict: "stale"');
    expect(outcome.content).toContain('superseded_by: "[[Ours]]"');
  });

  it("marks a dual rewrite of a human field or the body as a conflict", () => {
    const base = note('provenance: "agent"\ncreated: "2026-01-01"', "x\n");
    const ours = note('provenance: "agent"\ncreated: "2026-02-02"', "x\n");
    const theirs = note('provenance: "agent"\ncreated: "2026-03-03"', "x\n");
    expect(mergeVaultFile("Note.md", { base, ours, theirs })).toEqual({
      merged: false,
      content: conflictMarkers({ ours, theirs }),
    });
    const rewritten = mergeVaultFile("Note.md", {
      base: "we use bun\n",
      ours: "we use deno\n",
      theirs: "we use node\n",
    });
    expect(rewritten.merged).toBe(false);
    expect(splitConflictMarkers(rewritten.content)).toEqual({
      ours: "we use deno\n",
      theirs: "we use node\n",
    });
  });

  it("treats malformed frontmatter on any side as a conflict rather than guessing", () => {
    const outcome = mergeVaultFile("Note.md", {
      base: "x\n",
      ours: '---\nprovenance: "agent"\n',
      theirs: "y\n",
    });
    expect(outcome.merged).toBe(false);
  });
});

describe("merge driver: shared files", () => {
  it("set-merges the MOC: additions from both sides, removals from either", () => {
    const outcome = mergeVaultFile(".keywork/memory/MEMORY.md", {
      base: "- [[A]]\n- [[B]]\n- [[C]]\n",
      ours: "- [[A]]\n- [[C]]\n- [[D]]\n",
      theirs: "- [[A]]\n- [[B]]\n- [[E]]\n",
    });
    expect(outcome).toEqual({ merged: true, content: "- [[A]]\n- [[D]]\n- [[E]]\n" });
  });

  it("never conflicts on append-only logs", () => {
    expect(isAppendOnlyPath(".keywork/memory/daily/2026-08-10.alpha.md")).toBe(true);
    expect(isAppendOnlyPath("curation.beta.md")).toBe(true);
    expect(isAppendOnlyPath("Note.md")).toBe(false);
    const appended = mergeVaultFile("daily/2026-08-10.md", {
      base: "- 09:00 [prov: user] a\n",
      ours: "- 09:00 [prov: user] a\n- 10:00 [prov: user] b\n",
      theirs: "- 09:00 [prov: user] a\n- 11:00 [prov: user] c\n",
    });
    expect(appended).toEqual({
      merged: true,
      content: "- 09:00 [prov: user] a\n- 10:00 [prov: user] b\n- 11:00 [prov: user] c\n",
    });
    const rewritten = mergeVaultFile("curation.md", {
      base: "- t1 a\n- t2 b\n",
      ours: "- t1 a\n- t3 c\n",
      theirs: "- t2 b\n- t4 d\n",
    });
    expect(rewritten).toEqual({ merged: true, content: "- t1 a\n- t2 b\n- t3 c\n- t4 d\n" });
  });
});

describe("conflict markers", () => {
  it("splits git's hunk-level markers, diff3 base included, into two whole documents", () => {
    const raw = [
      "---",
      'provenance: "agent"',
      "<<<<<<< HEAD",
      "usefulness: 0.5",
      "||||||| merged common ancestors",
      "usefulness: 0.2",
      "=======",
      "usefulness: 0.3",
      ">>>>>>> theirs",
      "---",
      "shared body",
      "",
    ].join("\n");
    expect(splitConflictMarkers(raw)).toEqual({
      ours: '---\nprovenance: "agent"\nusefulness: 0.5\n---\nshared body\n',
      theirs: '---\nprovenance: "agent"\nusefulness: 0.3\n---\nshared body\n',
    });
    expect(splitConflictMarkers("no markers here\n")).toBeUndefined();
  });

  it("round-trips its own whole-file markers", () => {
    const sides = { ours: "a\n", theirs: "b\n" };
    expect(splitConflictMarkers(conflictMarkers(sides))).toEqual(sides);
  });
});

describe("primitives", () => {
  it("three-way merges text and frontmatter field by field", () => {
    expect(mergeText({ base: "a", ours: "a", theirs: "b" })).toBe("b");
    expect(mergeText({ base: "a", ours: "b", theirs: "a" })).toBe("b");
    expect(mergeText({ base: "a", ours: "b", theirs: "b" })).toBe("b");
    expect(mergeText({ base: "a", ours: "ab", theirs: "ac" })).toBe("abc");
    expect(mergeText({ base: "a", ours: "b", theirs: "c" })).toBeUndefined();
    expect(mergeFrontmatter({ k: "a" }, { k: "a", o: "1" }, { k: "b" })).toEqual({
      k: "b",
      o: "1",
    });
    expect(mergeFrontmatter({ k: "a" }, { k: "b" }, { k: "c" })).toBeUndefined();
    expect(mergeFrontmatter({ k: "a" }, {}, { k: "a" })).toEqual({});
  });
});
