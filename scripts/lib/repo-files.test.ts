import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { excludedDirectories, repoRoot, reportViolations, walkRepo } from "./repo-files.ts";

describe("walkRepo", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "keywork-walk-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lists every file as a sorted posix path relative to the root", async () => {
    seed(root, ["package.json", "scripts/b.ts", "scripts/a.ts", "docs/vision.md"]);
    expect(await walkRepo(() => true, root)).toEqual([
      "docs/vision.md",
      "package.json",
      "scripts/a.ts",
      "scripts/b.ts",
    ]);
  });

  it("skips the build and tool directories wherever they nest, but never docs", async () => {
    seed(root, [
      "node_modules/dep/package.json",
      ".git/config.json",
      ".claude/worktrees/w1/package.json",
      "dist/out.js",
      "artifacts/e2e/frame.txt",
      "packages/cli/dist/index.js",
      "packages/cli/node_modules/dep/index.js",
      "docs/backlog/package.json",
      "src/index.ts",
    ]);
    expect(await walkRepo(() => true, root)).toEqual(["docs/backlog/package.json", "src/index.ts"]);
  });

  it("hands the predicate the relative path and keeps only its matches", async () => {
    seed(root, ["a/package.json", "b/package.json", "b/readme.md"]);
    const seen: string[] = [];
    const manifests = await walkRepo((path) => {
      seen.push(path);
      return path.endsWith("package.json");
    }, root);
    expect(manifests).toEqual(["a/package.json", "b/package.json"]);
    expect(seen).toEqual(expect.arrayContaining(["b/readme.md"]));
  });

  it("names the exclusion set that both checkers share", () => {
    expect([...excludedDirectories].sort()).toEqual([
      ".claude",
      ".git",
      "artifacts",
      "dist",
      "node_modules",
    ]);
  });

  it("defaults to the repository root regardless of the working directory", () => {
    expect(existsSync(join(repoRoot, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(repoRoot, "scripts", "lib", "repo-files.ts"))).toBe(true);
  });
});

describe("reportViolations", () => {
  const label = { check: "check:demo", heading: "Demo violations:", scanned: "2 files" };

  it("prints the ok line with the scan summary and returns 0 when clean", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(reportViolations(label, [])).toBe(0);
      expect(log).toHaveBeenCalledWith("check:demo ok (2 files)");
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("prints the heading and each violation and returns 1 otherwise", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(reportViolations(label, ["a.ts: bad", "b.ts: worse"])).toBe(1);
      expect(error.mock.calls.map(([line]) => line)).toEqual([
        "Demo violations:",
        "  a.ts: bad",
        "  b.ts: worse",
      ]);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});

function seed(root: string, paths: readonly string[]): void {
  for (const path of paths) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "");
  }
}
