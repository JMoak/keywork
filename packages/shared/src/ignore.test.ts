import { describe, expect, it } from "vitest";
import { type IgnoreLayer, ignoresPath, ignoreVerdict, parseIgnoreFile } from "./ignore.ts";

function rootLayer(text: string): IgnoreLayer[] {
  return [{ base: "", patterns: parseIgnoreFile(text).patterns }];
}

function ignored(text: string, path: string, isDirectory = false): boolean {
  return ignoreVerdict(rootLayer(text), path, isDirectory);
}

describe("parseIgnoreFile", () => {
  it("skips blank lines and comments", () => {
    const file = parseIgnoreFile("\n# a comment\n  \nfoo\n");
    expect(file.patterns).toHaveLength(1);
    expect(file.problems).toHaveLength(0);
  });

  it("keeps a pattern that starts with an escaped hash", () => {
    expect(ignored("\\#tag", "#tag")).toBe(true);
  });

  it("strips unescaped trailing spaces but keeps escaped ones", () => {
    expect(ignored("foo   ", "foo")).toBe(true);
    expect(ignored("bar\\ ", "bar ")).toBe(true);
  });

  it("reports a never-closed character class once and skips the line", () => {
    const file = parseIgnoreFile("[oops\nfine.txt\n");
    expect(file.problems).toEqual([
      { line: 1, text: "[oops", reason: "character class is never closed" },
    ]);
    expect(file.patterns).toHaveLength(1);
    expect(ignoreVerdict([{ base: "", patterns: file.patterns }], "fine.txt", false)).toBe(true);
  });

  it("reports a trailing backslash as malformed", () => {
    const file = parseIgnoreFile("broken\\");
    expect(file.problems[0]?.reason).toBe("trailing backslash escapes nothing");
    expect(file.patterns).toHaveLength(0);
  });
});

describe("ignoreVerdict", () => {
  it("matches a bare name at any depth", () => {
    expect(ignored("foo", "foo")).toBe(true);
    expect(ignored("foo", "a/b/foo")).toBe(true);
    expect(ignored("foo", "a/foobar")).toBe(false);
  });

  it("anchors patterns containing a slash to the base", () => {
    expect(ignored("doc/frotz", "doc/frotz")).toBe(true);
    expect(ignored("doc/frotz", "a/doc/frotz")).toBe(false);
    expect(ignored("/frotz", "frotz")).toBe(true);
    expect(ignored("/frotz", "a/frotz")).toBe(false);
  });

  it("keeps * inside one path segment", () => {
    expect(ignored("*.log", "debug.log")).toBe(true);
    expect(ignored("*.log", "logs/debug.log")).toBe(true);
    expect(ignored("doc/*.log", "doc/debug.log")).toBe(true);
    expect(ignored("doc/*.log", "doc/deep/debug.log")).toBe(false);
  });

  it("lets a leading **/ cross directories", () => {
    expect(ignored("**/foo", "foo")).toBe(true);
    expect(ignored("**/foo", "a/b/foo")).toBe(true);
    expect(ignored("**/foo/bar", "a/foo/bar")).toBe(true);
  });

  it("lets a trailing /** match everything inside but not the directory itself", () => {
    expect(ignored("abc/**", "abc/x")).toBe(true);
    expect(ignored("abc/**", "abc/x/y")).toBe(true);
    expect(ignored("abc/**", "abc", true)).toBe(false);
  });

  it("lets a/**/b span zero or more directories", () => {
    expect(ignored("a/**/b", "a/b")).toBe(true);
    expect(ignored("a/**/b", "a/x/b")).toBe(true);
    expect(ignored("a/**/b", "a/x/y/b")).toBe(true);
  });

  it("treats other double stars as a plain star", () => {
    expect(ignored("a**b", "aXb")).toBe(true);
    expect(ignored("a**b", "a/b")).toBe(false);
  });

  it("matches ? as exactly one character that is not a slash", () => {
    expect(ignored("fo?", "foo")).toBe(true);
    expect(ignored("fo?", "fo")).toBe(false);
    expect(ignored("fo?", "fo/")).toBe(false);
  });

  it("supports character classes with negation", () => {
    expect(ignored("file[0-9].txt", "file3.txt")).toBe(true);
    expect(ignored("file[!0-9].txt", "filea.txt")).toBe(true);
    expect(ignored("file[!0-9].txt", "file3.txt")).toBe(false);
  });

  it("restricts directory-only patterns to directories", () => {
    expect(ignored("build/", "build", true)).toBe(true);
    expect(ignored("build/", "build", false)).toBe(false);
    expect(ignored("build/", "a/build", true)).toBe(true);
  });

  it("gives the last matching rule the verdict, matching gitignore negation order", () => {
    expect(ignored("*.log\n!important.log", "important.log")).toBe(false);
    expect(ignored("*.log\n!important.log", "debug.log")).toBe(true);
    expect(ignored("!important.log\n*.log", "important.log")).toBe(true);
  });

  it("escapes a leading bang to match a literal one", () => {
    expect(ignored("\\!readme", "!readme")).toBe(true);
  });

  it("lets a deeper layer override a shallower one", () => {
    const layers: IgnoreLayer[] = [
      { base: "", patterns: parseIgnoreFile("*.log").patterns },
      { base: "sub", patterns: parseIgnoreFile("!keep.log").patterns },
    ];
    expect(ignoreVerdict(layers, "sub/keep.log", false)).toBe(false);
    expect(ignoreVerdict(layers, "top/keep.log", false)).toBe(true);
    expect(ignoreVerdict(layers, "sub/other.log", false)).toBe(true);
  });

  it("never applies a layer outside its base", () => {
    const layers: IgnoreLayer[] = [{ base: "sub", patterns: parseIgnoreFile("foo").patterns }];
    expect(ignoreVerdict(layers, "foo", false)).toBe(false);
    expect(ignoreVerdict(layers, "sub/foo", false)).toBe(true);
  });
});

describe("ignoresPath", () => {
  it("cannot re-include a file whose parent directory is excluded", () => {
    const layers = rootLayer("build/\n!build/keep.txt");
    expect(ignoresPath(layers, "build/keep.txt")).toBe(true);
  });

  it("re-includes when only the file itself was excluded", () => {
    const layers = rootLayer("build/*.txt\n!build/keep.txt");
    expect(ignoresPath(layers, "build/keep.txt")).toBe(false);
    expect(ignoresPath(layers, "build/drop.txt")).toBe(true);
  });
});
