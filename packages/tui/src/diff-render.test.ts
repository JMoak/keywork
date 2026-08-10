import { describe, expect, it } from "vitest";
import { type DiffLine, mutationDiff, unifiedDiff } from "./diff-render.ts";

function render(lines: readonly DiffLine[]): string[] {
  return lines.map((line) => `${line.kind}:${line.text}`);
}

describe("unifiedDiff", () => {
  it("marks a single changed line with surrounding context and a hunk header", () => {
    const before = ["a", "b", "c", "d", "e", "f"].join("\n");
    const after = ["a", "b", "c!", "d", "e", "f"].join("\n");
    expect(render(unifiedDiff(before, after))).toEqual([
      "hunk:@@ -1,5 +1,5 @@",
      "context:a",
      "context:b",
      "del:c",
      "add:c!",
      "context:d",
      "context:e",
    ]);
  });

  it("reports identical content as no changes", () => {
    expect(unifiedDiff("same\ntext", "same\ntext")).toEqual([{ kind: "note", text: "no changes" }]);
  });

  it("treats CRLF and LF variants of the same text as no changes", () => {
    expect(unifiedDiff("one\r\ntwo\r\n", "one\ntwo\n")).toEqual([
      { kind: "note", text: "no changes" },
    ]);
  });

  it("renders a pure deletion", () => {
    const lines = unifiedDiff("keep\ngone\n", "keep\n");
    expect(render(lines)).toContain("del:gone");
    expect(lines.some((line) => line.kind === "add")).toBe(false);
  });

  it("splits distant changes into separate hunks", () => {
    const before = Array.from({ length: 30 }, (_, at) => `line ${at}`).join("\n");
    const after = before.replace("line 2", "line two").replace("line 27", "line twenty-seven");
    const hunks = unifiedDiff(before, after).filter((line) => line.kind === "hunk");
    expect(hunks).toHaveLength(2);
  });

  it("caps enormous diffs with an elision note", () => {
    const before = Array.from({ length: 400 }, (_, at) => `old ${at}`).join("\n");
    const after = Array.from({ length: 400 }, (_, at) => `new ${at}`).join("\n");
    const lines = unifiedDiff(before, after);
    expect(lines.length).toBeLessThanOrEqual(160);
    expect(lines.at(-1)?.kind).toBe("note");
    expect(lines.at(-1)?.text).toContain("more diff lines");
  });
});

describe("mutationDiff", () => {
  const files: Record<string, string> = {
    "notes.txt": "alpha\nbeta\ngamma\n",
    "crlf.txt": "one\r\ntwo\r\n",
  };
  const read = (path: string) => files[path];

  it("previews a write to an existing file as del/add lines", () => {
    const lines = mutationDiff(
      "write",
      { path: "notes.txt", content: "alpha\nBETA\ngamma\n" },
      read,
    );
    expect(render(lines ?? [])).toEqual([
      "hunk:@@ -1,3 +1,3 @@",
      "context:alpha",
      "del:beta",
      "add:BETA",
      "context:gamma",
    ]);
  });

  it("previews a brand-new file as a note plus pure additions", () => {
    const lines = mutationDiff("write", { path: "fresh.txt", content: "hello\nworld" }, read) ?? [];
    expect(lines[0]).toEqual({ kind: "note", text: "new file fresh.txt" });
    expect(lines.filter((line) => line.kind === "add").map((line) => line.text)).toEqual([
      "hello",
      "world",
    ]);
    expect(lines.some((line) => line.kind === "del")).toBe(false);
  });

  it("previews emptying a file as pure deletions", () => {
    const lines = mutationDiff("write", { path: "notes.txt", content: "" }, read) ?? [];
    expect(lines.filter((line) => line.kind === "del").map((line) => line.text)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(lines.some((line) => line.kind === "add")).toBe(false);
  });

  it("previews an edit by applying the replacement to the current content", () => {
    const lines = mutationDiff(
      "edit",
      { path: "notes.txt", oldText: "beta", newText: "delta" },
      read,
    );
    expect(render(lines ?? [])).toContain("del:beta");
    expect(render(lines ?? [])).toContain("add:delta");
  });

  it("previews an edit of a CRLF file without spurious whole-file churn", () => {
    const lines = mutationDiff("edit", { path: "crlf.txt", oldText: "one", newText: "uno" }, read);
    expect(render(lines ?? [])).toEqual([
      "hunk:@@ -1,2 +1,2 @@",
      "del:one",
      "add:uno",
      "context:two",
    ]);
  });

  it("reports a no-op edit as no changes", () => {
    const lines = mutationDiff(
      "edit",
      { path: "notes.txt", oldText: "beta", newText: "beta" },
      read,
    );
    expect(lines).toEqual([{ kind: "note", text: "no changes" }]);
  });

  it("states truthfully when an edit target is missing or ambiguous", () => {
    expect(
      mutationDiff("edit", { path: "notes.txt", oldText: "nope", newText: "x" }, read)?.[0]?.text,
    ).toContain("not found");
    expect(
      mutationDiff("edit", { path: "gone.txt", oldText: "a", newText: "b" }, read)?.[0]?.text,
    ).toContain("cannot be read");
    expect(
      mutationDiff("edit", { path: "notes.txt", oldText: "a", newText: "b" }, read)?.[0]?.text,
    ).toContain("matches");
  });

  it("yields no diff for non-write tools or malformed arguments", () => {
    expect(mutationDiff("bash", { command: "rm -rf" }, read)).toBeUndefined();
    expect(mutationDiff("write", { path: 42 }, read)).toBeUndefined();
    expect(mutationDiff("edit", "not-an-object", read)).toBeUndefined();
  });
});
