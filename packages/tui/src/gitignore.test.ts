import { describe, expect, it } from "vitest";
import { IgnoreRules, parseGitignore } from "./gitignore.ts";

function rulesOf(text: string, directory = ""): IgnoreRules {
  const rules = new IgnoreRules();
  rules.add(directory, text);
  return rules;
}

describe("gitignore patterns", () => {
  it("matches a bare name at any depth, for files and directories", () => {
    const rules = rulesOf("node_modules\n*.log");
    expect(rules.ignores("node_modules", "dir")).toBe(true);
    expect(rules.ignores("packages/tui/node_modules", "dir")).toBe(true);
    expect(rules.ignores("debug.log", "file")).toBe(true);
    expect(rules.ignores("out/build.log", "file")).toBe(true);
    expect(rules.ignores("changelog", "file")).toBe(false);
  });

  it("anchors patterns with a slash to the .gitignore directory", () => {
    const rules = rulesOf("/dist\nbuild/output\n");
    expect(rules.ignores("dist", "dir")).toBe(true);
    expect(rules.ignores("packages/dist", "dir")).toBe(false);
    expect(rules.ignores("build/output", "file")).toBe(true);
    expect(rules.ignores("nested/build/output", "file")).toBe(false);
  });

  it("restricts trailing-slash patterns to directories", () => {
    const rules = rulesOf("cache/");
    expect(rules.ignores("cache", "dir")).toBe(true);
    expect(rules.ignores("cache", "file")).toBe(false);
  });

  it("lets a later negation re-include a match", () => {
    const rules = rulesOf("*.env\n!example.env");
    expect(rules.ignores("local.env", "file")).toBe(true);
    expect(rules.ignores("example.env", "file")).toBe(false);
  });

  it("keeps everything under an ignored directory ignored even with a negation", () => {
    const rules = rulesOf("vendor/\n!vendor/keep.txt");
    expect(rules.ignoresWithin("vendor/keep.txt", "file")).toBe(true);
    expect(rules.ignoresWithin("src/keep.txt", "file")).toBe(false);
  });

  it("skips comments, blank lines, and trailing spaces, honoring escapes", () => {
    const rules = rulesOf("# comment\n\n\\#literal\ntrailing   \nspaced\\ \n");
    expect(rules.ignores("#literal", "file")).toBe(true);
    expect(rules.ignores("trailing", "file")).toBe(true);
    expect(rules.ignores("spaced ", "file")).toBe(true);
    expect(rules.ignores("spaced", "file")).toBe(false);
    expect(parseGitignore("# only comments\n\n")).toEqual([]);
  });

  it("understands ** at the start, middle, and end", () => {
    const rules = rulesOf("**/logs\ndocs/**/draft.md\ncoverage/**");
    expect(rules.ignores("logs", "dir")).toBe(true);
    expect(rules.ignores("a/b/logs", "dir")).toBe(true);
    expect(rules.ignores("docs/draft.md", "file")).toBe(true);
    expect(rules.ignores("docs/x/y/draft.md", "file")).toBe(true);
    expect(rules.ignores("coverage/lcov.info", "file")).toBe(true);
    expect(rules.ignores("coverage", "dir")).toBe(false);
  });

  it("keeps * from crossing a slash and lets ? and [] match one character", () => {
    const rules = rulesOf("src/*.js\nfile?.txt\n[ab].md\n[!x].rs");
    expect(rules.ignores("src/app.js", "file")).toBe(true);
    expect(rules.ignores("src/lib/app.js", "file")).toBe(false);
    expect(rules.ignores("file1.txt", "file")).toBe(true);
    expect(rules.ignores("file12.txt", "file")).toBe(false);
    expect(rules.ignores("a.md", "file")).toBe(true);
    expect(rules.ignores("c.md", "file")).toBe(false);
    expect(rules.ignores("y.rs", "file")).toBe(true);
    expect(rules.ignores("x.rs", "file")).toBe(false);
  });

  it("treats regex metacharacters in patterns as literals", () => {
    const rules = rulesOf("a+b(c).txt");
    expect(rules.ignores("a+b(c).txt", "file")).toBe(true);
    expect(rules.ignores("aab(c).txt", "file")).toBe(false);
  });
});

describe("nested .gitignore files", () => {
  it("scopes each file to its directory and lets deeper files win", () => {
    const rules = new IgnoreRules();
    rules.add("", "*.tmp\n");
    rules.add("packages/tui", "!keep.tmp\nfixtures/");
    expect(rules.ignores("a.tmp", "file")).toBe(true);
    expect(rules.ignores("packages/tui/keep.tmp", "file")).toBe(false);
    expect(rules.ignores("packages/engine/keep.tmp", "file")).toBe(true);
    expect(rules.ignores("packages/tui/fixtures", "dir")).toBe(true);
    expect(rules.ignores("fixtures", "dir")).toBe(false);
  });

  it("orders by depth regardless of the order files were added", () => {
    const rules = new IgnoreRules();
    rules.add("packages\\tui", "!keep.tmp");
    rules.add(".", "*.tmp");
    expect(rules.ignores("packages/tui/keep.tmp", "file")).toBe(false);
  });

  it("replaces a directory's rules when re-added, and clear forgets all", () => {
    const rules = new IgnoreRules();
    rules.add("", "old");
    rules.add("", "new");
    expect(rules.ignores("old", "file")).toBe(false);
    expect(rules.ignores("new", "file")).toBe(true);
    rules.clear();
    expect(rules.ignores("new", "file")).toBe(false);
  });
});

describe("gitignore properties", () => {
  const names = ["a", "b", "c.log", "dist", "x.tmp"];
  let seed = 11;
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const randomPath = (): string =>
    Array.from({ length: 1 + Math.floor(random() * 4) }, () => pick(names)).join("/");

  it("an exact anchored pattern matches its own path and only paths inside it", () => {
    for (let round = 0; round < 200; round += 1) {
      const path = randomPath();
      const rules = rulesOf(`/${path}`);
      expect(rules.ignores(path, "file")).toBe(true);
      expect(rules.ignores(`${path}/child`, "file")).toBe(false);
      expect(rules.ignoresWithin(`${path}/child`, "file")).toBe(true);
    }
  });

  it("negating a rule flips its verdict and directory-only rules never hit files", () => {
    for (let round = 0; round < 200; round += 1) {
      const path = randomPath();
      const plain = rulesOf(path);
      const negated = rulesOf(`${path}\n!${path}`);
      const directoryOnly = rulesOf(`${path}/`);
      expect(plain.ignores(path, "file")).toBe(true);
      expect(negated.ignores(path, "file")).toBe(false);
      expect(directoryOnly.ignores(path, "file")).toBe(false);
      expect(directoryOnly.ignores(path, "dir")).toBe(true);
    }
  });

  it("ignoresWithin agrees with ignores whenever no ancestor is ignored", () => {
    for (let round = 0; round < 200; round += 1) {
      const rules = rulesOf(`${pick(names)}\n*.log\n!${pick(names)}`);
      const path = randomPath();
      const segments = path.split("/");
      const ancestorIgnored = segments
        .slice(0, -1)
        .some((_, depth) => rules.ignores(segments.slice(0, depth + 1).join("/"), "dir"));
      if (!ancestorIgnored) {
        expect(rules.ignoresWithin(path, "file")).toBe(rules.ignores(path, "file"));
      } else {
        expect(rules.ignoresWithin(path, "file")).toBe(true);
      }
    }
  });
});
