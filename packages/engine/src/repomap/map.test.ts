import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractSymbols } from "./extract.ts";
import { estimateTokens, RepoMap, repoMapTokenBudget } from "./map.ts";
import { scanWorkspace } from "./scan.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "keywork-repomap-"));
  tempDirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content, "utf8");
  }
  return root;
}

async function builtMap(files: Record<string, string>): Promise<RepoMap> {
  const map = new RepoMap({ root: await workspace(files) });
  await map.build();
  return map;
}

describe("extractSymbols", () => {
  it("finds exported TypeScript declarations and export lists", () => {
    const symbols = extractSymbols(
      "a.ts",
      [
        "export function alpha() {}",
        "export const beta = 1;",
        "export interface Gamma {}",
        "export type Delta = string;",
        "export class Epsilon {}",
        "export default class Zeta {}",
        "export { eta, theta as iota };",
        "const hidden = 2;",
      ].join("\n"),
    );
    expect(symbols).toEqual(["alpha", "beta", "Gamma", "Delta", "Epsilon", "Zeta", "eta", "iota"]);
  });

  it("finds top-level python definitions and skips private ones", () => {
    const symbols = extractSymbols(
      "a.py",
      "def visible():\n    pass\nclass Thing:\n    def _x(self):\n        pass\ndef _private():\n    pass\n",
    );
    expect(symbols).toEqual(["visible", "Thing"]);
  });

  it("finds exported go declarations", () => {
    const symbols = extractSymbols(
      "a.go",
      "func Public() {}\nfunc private() {}\nfunc (r *Recv) Method() {}\ntype Widget struct{}\nvar Count int\n",
    );
    expect(symbols).toEqual(["Public", "Method", "Widget", "Count"]);
  });

  it("finds pub rust items", () => {
    const symbols = extractSymbols(
      "a.rs",
      "pub fn run() {}\nfn hidden() {}\npub struct Gear;\n  pub async fn fetch() {}\npub trait Turn {}\n",
    );
    expect(symbols).toEqual(["run", "Gear", "fetch", "Turn"]);
  });

  it("uses markdown headings as symbols", () => {
    expect(extractSymbols("a.md", "# Title\ntext\n## Deep Dive\n")).toEqual(["Title", "Deep Dive"]);
  });

  it("returns nothing for unknown extensions", () => {
    expect(extractSymbols("a.bin", "export function x() {}")).toEqual([]);
  });
});

describe("RepoMap ranking", () => {
  it("surfaces the most referenced files first", async () => {
    const map = await builtMap({
      "core.ts": "export function widely() {}\nexport function alsoWidely() {}",
      "a.ts": "import { widely } from './core.ts';\nexport function one() { widely(); }",
      "b.ts":
        "import { widely, alsoWidely } from './core.ts';\nexport function two() { widely(); alsoWidely(); }",
      "lonely.ts": "export function nobodyCalls() {}",
    });
    const rendered = map.serialize(1000);
    const lines = rendered.split("\n");
    expect(lines[0]).toMatch(/^core\.ts: widely, alsoWidely/);
    expect(rendered).toContain("lonely.ts: nobodyCalls");
  });

  it("keeps ordering deterministic for equal weights", async () => {
    const files = { "b.ts": "export const same = 1;", "a.ts": "export const alike = 1;" };
    const first = (await builtMap(files)).serialize(1000);
    const second = (await builtMap(files)).serialize(1000);
    expect(first).toBe(second);
    expect(first.indexOf("a.ts")).toBeLessThan(first.indexOf("b.ts"));
  });
});

describe("RepoMap incremental cache", () => {
  it("re-extracts only files whose mtime or size changed", async () => {
    const root = await workspace({
      "one.ts": "export const one = 1;",
      "two.ts": "export const two = 2;",
    });
    const map = new RepoMap({ root });
    await map.build();
    expect(map.extractionCount()).toBe(2);
    await writeFile(join(root, "one.ts"), "export const one = 111;", "utf8");
    await utimes(join(root, "one.ts"), new Date(), new Date(Date.now() + 5_000));
    map.markStale();
    await map.refreshIfStale();
    expect(map.extractionCount()).toBe(3);
  });

  it("drops vanished files on rebuild", async () => {
    const root = await workspace({
      "keep.ts": "export const keep = 1;",
      "gone.ts": "export const gone = 1;",
    });
    const map = new RepoMap({ root });
    await map.build();
    await rm(join(root, "gone.ts"));
    map.markStale();
    await map.refreshIfStale();
    expect(map.serialize(1000)).not.toContain("gone.ts");
    expect(map.facts().files).toBe(1);
  });

  it("skips rebuilding when nothing was marked stale", async () => {
    const map = await builtMap({ "one.ts": "export const one = 1;" });
    const before = map.extractionCount();
    await map.refreshIfStale();
    expect(map.extractionCount()).toBe(before);
  });
});

describe("RepoMap budget", () => {
  it("never exceeds the token budget, even on a 4k window", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 60; index += 1) {
      files[`file-${String(index).padStart(2, "0")}.ts`] =
        `export function symbolNumber${index}WithALongerName() {}`;
    }
    const map = await builtMap(files);
    const budget = repoMapTokenBudget(4_096);
    expect(budget).toBe(128);
    const rendered = map.serialize(budget);
    expect(estimateTokens(rendered)).toBeLessThanOrEqual(budget);
    expect(rendered).toMatch(/… \d+ more files$/);
  });

  it("returns an empty string when nothing fits", async () => {
    const map = await builtMap({ "a.ts": "export const something = 1;" });
    expect(map.serialize(1)).toBe("");
  });

  it("shows every file with no tail when the budget is roomy", async () => {
    const map = await builtMap({ "a.ts": "export const something = 1;" });
    const rendered = map.serialize(1000);
    expect(rendered).toBe("a.ts: something");
  });

  it("caps the per-line symbol list honestly", async () => {
    const names = Array.from({ length: 20 }, (_, index) => `name${index}`);
    const map = await builtMap({
      "big.ts": names.map((name) => `export const ${name} = 1;`).join("\n"),
    });
    const rendered = map.serialize(1000);
    expect(rendered).toContain(" +8");
    expect(rendered).not.toContain("name19");
  });

  it("derives the budget from the declared window with a cap", () => {
    expect(repoMapTokenBudget(undefined)).toBe(2048);
    expect(repoMapTokenBudget(1_000_000)).toBe(2048);
    expect(repoMapTokenBudget(4_096)).toBe(128);
  });
});

describe("RepoMap ignore handling", () => {
  it("respects .keyworkignore and .gitignore with negation", async () => {
    const map = await builtMap({
      ".gitignore": "generated/",
      ".keyworkignore": "*.md\n!KEEP.md",
      "generated/out.ts": "export const generated = 1;",
      "notes.md": "# Notes",
      "KEEP.md": "# Keep",
      "src/main.ts": "export const main = 1;",
    });
    const rendered = map.serialize(1000);
    expect(rendered).not.toContain("generated/out.ts");
    expect(rendered).not.toContain("notes.md");
    expect(rendered).toContain("KEEP.md");
    expect(rendered).toContain("src/main.ts");
  });

  it("reports a malformed ignore line once and keeps scanning", async () => {
    const map = await builtMap({
      ".keyworkignore": "[broken\n*.log",
      "kept.ts": "export const kept = 1;",
    });
    const facts = map.facts();
    expect(facts.ignoreProblems).toHaveLength(1);
    expect(facts.ignoreProblems[0]).toMatchObject({
      file: ".keyworkignore",
      line: 1,
      reason: "character class is never closed",
    });
    expect(map.serialize(1000)).toContain("kept.ts");
  });

  it("lets a nested ignore file govern its own directory", async () => {
    const map = await builtMap({
      "sub/.keyworkignore": "local.ts",
      "sub/local.ts": "export const local = 1;",
      "local.ts": "export const rootLocal = 1;",
    });
    const rendered = map.serialize(1000);
    expect(rendered).not.toContain("sub/local.ts");
    expect(rendered).toContain("local.ts: rootLocal");
  });
});

describe("RepoMap adversarial trees", () => {
  it("maps a 5000-file tree quickly and truncates the scan honestly", async () => {
    const root = await mkdtemp(join(tmpdir(), "keywork-repomap-big-"));
    tempDirs.push(root);
    for (let dir = 0; dir < 50; dir += 1) {
      await mkdir(join(root, `pkg-${dir}`), { recursive: true });
      await Promise.all(
        Array.from({ length: 100 }, (_, file) =>
          writeFile(
            join(root, `pkg-${dir}`, `mod-${file}.ts`),
            `export function pkg${dir}mod${file}() {}\n`,
            "utf8",
          ),
        ),
      );
    }
    const map = new RepoMap({ root, maxFiles: 4_000 });
    const begun = Date.now();
    await map.build();
    expect(Date.now() - begun).toBeLessThan(30_000);
    const facts = map.facts();
    expect(facts.files).toBe(4_000);
    expect(facts.truncated).toBe(true);
    const rendered = map.serialize(repoMapTokenBudget(undefined));
    expect(estimateTokens(rendered)).toBeLessThanOrEqual(repoMapTokenBudget(undefined));
    expect(rendered).toMatch(/… \d+ more files$/);
  }, 60_000);

  it("does not hang on symlink cycles", async () => {
    const root = await workspace({ "real/a.ts": "export const a = 1;" });
    const canLink = await symlink(join(root, "real"), join(root, "real", "loop"), "junction").then(
      () => true,
      () => false,
    );
    if (!canLink) return;
    const map = new RepoMap({ root });
    await map.build();
    expect(map.serialize(1000)).toContain("real/a.ts");
  }, 15_000);

  it("skips unreadable and binary-looking files without failing the build", async () => {
    const root = await workspace({ "good.ts": "export const good = 1;" });
    await writeFile(join(root, "blob.ts"), Buffer.from([0, 1, 2, 0, 3]));
    const map = new RepoMap({ root });
    await map.build();
    const rendered = map.serialize(1000);
    expect(rendered).toContain("good.ts");
    expect(rendered).not.toContain("blob.ts");
  });
});

describe("scanWorkspace", () => {
  it("counts ignored paths", async () => {
    const root = await workspace({
      ".keyworkignore": "skip.ts",
      "skip.ts": "export const skip = 1;",
      "kept.ts": "export const kept = 1;",
    });
    const scan = await scanWorkspace(root);
    expect(scan.ignoredPaths).toBe(1);
    expect(scan.files.map((file) => file.path)).toContain("kept.ts");
  });
});
