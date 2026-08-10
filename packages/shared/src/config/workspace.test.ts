import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "./load.ts";
import { openWorkspace, resolveVaultPath } from "./workspace.ts";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-workspace-"));
  tempDirs.push(dir);
  return dir;
}

async function declareWorkspace(root: string, declaration: object | string): Promise<string> {
  const file = join(root, ".keywork", "workspace.json");
  await mkdir(join(root, ".keywork"), { recursive: true });
  const body = typeof declaration === "string" ? declaration : JSON.stringify(declaration);
  await writeFile(file, body);
  return file;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("openWorkspace", () => {
  it("returns undefined silently when no declaration exists", async () => {
    const root = await tempRoot();
    expect(openWorkspace(root)).toBeUndefined();
  });

  it("opens the workspace declared in the cwd's own .keywork", async () => {
    const root = await tempRoot();
    const file = await declareWorkspace(root, { name: "alpha" });

    const workspace = openWorkspace(root);

    expect(workspace).toMatchObject({
      root,
      declarationFile: file,
      name: "alpha",
      contextDirs: [],
      missingContextDirs: [],
    });
  });

  it("walks up from a nested cwd to the declaration, git-style", async () => {
    const root = await tempRoot();
    await declareWorkspace(root, { name: "alpha" });
    const nested = join(root, "packages", "deep", "leaf");
    await mkdir(nested, { recursive: true });

    expect(openWorkspace(nested)?.root).toBe(root);
  });

  it("prefers the nearest declaration when several exist above the cwd", async () => {
    const root = await tempRoot();
    await declareWorkspace(root, { name: "outer" });
    const inner = join(root, "sub");
    await mkdir(inner, { recursive: true });
    await declareWorkspace(inner, { name: "inner" });

    await mkdir(join(inner, "src"), { recursive: true });

    expect(openWorkspace(join(inner, "src"))?.name).toBe("inner");
    expect(openWorkspace(root)?.name).toBe("outer");
  });

  it("resolves the vault path beside the declaration", async () => {
    const root = await tempRoot();
    await declareWorkspace(root, { name: "alpha" });
    const nested = join(root, "sub");
    await mkdir(nested, { recursive: true });

    expect(openWorkspace(nested)?.vaultPath).toBe(join(root, ".keywork", "memory"));
  });

  it("resolves context dirs against the root, keeps absolutes, and dedupes", async () => {
    const root = await tempRoot();
    const sibling = await tempRoot();
    await mkdir(join(root, "docs"), { recursive: true });
    await declareWorkspace(root, {
      name: "alpha",
      contextDirs: ["docs", "./docs", sibling, "docs/../docs"],
    });

    expect(openWorkspace(root)?.contextDirs).toEqual([join(root, "docs"), sibling]);
  });

  it("never lists the primary root as an additional context dir", async () => {
    const root = await tempRoot();
    await declareWorkspace(root, { name: "alpha", contextDirs: [".", root] });

    const workspace = openWorkspace(root);

    expect(workspace?.contextDirs).toEqual([]);
    expect(workspace?.missingContextDirs).toEqual([]);
  });

  it("skips missing context dirs into missingContextDirs without failing", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "docs"), { recursive: true });
    await declareWorkspace(root, { name: "alpha", contextDirs: ["docs", "gone"] });

    const workspace = openWorkspace(root);

    expect(workspace?.contextDirs).toEqual([join(root, "docs")]);
    expect(workspace?.missingContextDirs).toEqual([join(root, "gone")]);
  });

  it("treats a context dir pointing at a file as missing", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "notes.md"), "");
    await declareWorkspace(root, { name: "alpha", contextDirs: ["notes.md"] });

    expect(openWorkspace(root)?.missingContextDirs).toEqual([join(root, "notes.md")]);
  });

  it("resolves traversal in context dirs instead of crashing", async () => {
    const root = await tempRoot();
    await declareWorkspace(root, { name: "alpha", contextDirs: ["../../does-not-exist"] });

    expect(openWorkspace(root)?.missingContextDirs).toEqual([
      resolve(root, "../../does-not-exist"),
    ]);
  });

  it("rejects malformed JSON as a hard error naming the file", async () => {
    const root = await tempRoot();
    await declareWorkspace(root, "{ not json");

    expect(() => openWorkspace(root)).toThrow(ConfigError);
    expect(() => openWorkspace(root)).toThrow(/workspace\.json/);
    expect(() => openWorkspace(root)).toThrow(/not valid JSON/);
  });

  it("rejects wrong field types", async () => {
    const root = await tempRoot();
    await declareWorkspace(root, { name: 42, contextDirs: "docs" });

    expect(() => openWorkspace(root)).toThrow(ConfigError);
  });

  it("rejects unknown keys", async () => {
    const root = await tempRoot();
    await declareWorkspace(root, { name: "alpha", vault: "elsewhere" });

    expect(() => openWorkspace(root)).toThrow(ConfigError);
  });

  it("rejects a missing name", async () => {
    const root = await tempRoot();
    await declareWorkspace(root, { contextDirs: ["docs"] });

    expect(() => openWorkspace(root)).toThrow(ConfigError);
  });

  it("rejects empty and oversized strings", async () => {
    const root = await tempRoot();
    await declareWorkspace(root, { name: "" });
    expect(() => openWorkspace(root)).toThrow(ConfigError);

    await declareWorkspace(root, { name: "x".repeat(121) });
    expect(() => openWorkspace(root)).toThrow(ConfigError);

    await declareWorkspace(root, { name: "alpha", contextDirs: ["y".repeat(1025)] });
    expect(() => openWorkspace(root)).toThrow(ConfigError);
  });

  it("rejects an unreadable declaration as a hard error", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".keywork", "workspace.json"), { recursive: true });

    expect(() => openWorkspace(root)).toThrow(ConfigError);
    expect(() => openWorkspace(root)).toThrow(/unreadable|not valid JSON/);
  });
});

describe("resolveVaultPath", () => {
  it("is undefined for an undeclared cwd", async () => {
    const root = await tempRoot();
    expect(resolveVaultPath(root)).toBeUndefined();
  });

  it("points at .keywork/memory beside the declaration", async () => {
    const root = await tempRoot();
    await declareWorkspace(root, { name: "alpha" });
    const nested = join(root, "a", "b");
    await mkdir(nested, { recursive: true });

    expect(resolveVaultPath(nested)).toBe(join(root, ".keywork", "memory"));
  });
});
