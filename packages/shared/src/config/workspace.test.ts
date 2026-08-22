import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "./load.ts";
import {
  listWorkspaces,
  namedWorkspaceDir,
  openWorkspace,
  resolveVaultPath,
  writeNamedWorkspaceDeclaration,
} from "./workspace.ts";

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

  it("rejects a declaration nested inside another declared workspace", async () => {
    const root = await tempRoot();
    await declareWorkspace(root, { name: "outer" });
    const inner = join(root, "sub");
    await mkdir(inner, { recursive: true });
    await declareWorkspace(inner, { name: "inner" });

    await mkdir(join(inner, "src"), { recursive: true });

    expect(() => openWorkspace(join(inner, "src"))).toThrow("nested workspace anchors");
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

describe("named workspaces (PD10)", () => {
  it("lists only the undeclared default slot for a bare root", async () => {
    const root = await tempRoot();
    expect(listWorkspaces(root)).toEqual([
      {
        slug: undefined,
        name: undefined,
        declared: false,
        declarationFile: join(root, ".keywork", "workspace.json"),
        vaultPath: join(root, ".keywork", "memory"),
      },
    ]);
  });

  it("keeps the default workspace byte-stable while named ones live beside it", async () => {
    const root = await tempRoot();
    const defaultFile = await declareWorkspace(root, { name: "alpha" });
    const before = await readFile(defaultFile, "utf8");

    const file = writeNamedWorkspaceDeclaration(root, "frontend", { name: "Frontend revamp" });

    expect(file).toBe(join(namedWorkspaceDir(root, "frontend"), "workspace.json"));
    expect(await readFile(defaultFile, "utf8")).toBe(before);
    expect(openWorkspace(root)?.vaultPath).toBe(join(root, ".keywork", "memory"));
    expect(listWorkspaces(root).map((slot) => [slot.slug, slot.name])).toEqual([
      [undefined, "alpha"],
      ["frontend", "Frontend revamp"],
    ]);
  });

  it("opens a named workspace from any subdirectory with its own vault and context dirs", async () => {
    const root = await tempRoot();
    await declareWorkspace(root, { name: "alpha" });
    await mkdir(join(root, "web"), { recursive: true });
    writeNamedWorkspaceDeclaration(root, "frontend", { name: "Frontend", contextDirs: ["web"] });
    const nested = join(root, "packages", "deep");
    await mkdir(nested, { recursive: true });

    const workspace = openWorkspace(nested, "frontend");

    expect(workspace).toMatchObject({
      root,
      slug: "frontend",
      name: "Frontend",
      contextDirs: [join(root, "web")],
      vaultPath: join(root, ".keywork", "workspaces", "frontend", "memory"),
    });
    expect(resolveVaultPath(nested, "frontend")).toBe(workspace?.vaultPath);
    expect(openWorkspace(nested)?.contextDirs).toEqual([]);
  });

  it("anchors named workspaces at the git root even before the default is declared", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".git"), { recursive: true });
    writeNamedWorkspaceDeclaration(root, "infra", { name: "Infra" });
    const nested = join(root, "ops");
    await mkdir(nested, { recursive: true });

    expect(openWorkspace(nested, "infra")?.root).toBe(root);
    expect(openWorkspace(nested)).toBeUndefined();
    expect(listWorkspaces(root).map((slot) => slot.slug)).toEqual([undefined, "infra"]);
  });

  it("is undefined for an unknown or malformed slug", async () => {
    const root = await tempRoot();
    expect(openWorkspace(root, "ghost")).toBeUndefined();
    expect(openWorkspace(root, "Not A Slug")).toBeUndefined();
  });

  it("refuses to create a workspace under an invalid slug", async () => {
    const root = await tempRoot();
    expect(() => writeNamedWorkspaceDeclaration(root, "Bad Slug", { name: "x" })).toThrow(
      ConfigError,
    );
    expect(listWorkspaces(root)).toHaveLength(1);
  });

  it("lists a corrupt named declaration as an unavailable slot beside the healthy ones", async () => {
    const root = await tempRoot();
    await declareWorkspace(root, { name: "alpha" });
    writeNamedWorkspaceDeclaration(root, "good", { name: "Good" });
    const badFile = join(namedWorkspaceDir(root, "bad"), "workspace.json");
    await mkdir(namedWorkspaceDir(root, "bad"), { recursive: true });
    await writeFile(badFile, "{ corrupt");

    const slots = listWorkspaces(root);

    expect(slots.map((slot) => [slot.slug, slot.name, slot.declared])).toEqual([
      [undefined, "alpha", true],
      ["bad", undefined, true],
      ["good", "Good", true],
    ]);
    expect(slots[1]?.problem).toMatch(/not valid JSON/);
    expect(slots[1]?.declarationFile).toBe(badFile);
    expect(
      slots.filter((slot) => slot.slug !== "bad").every((slot) => slot.problem === undefined),
    ).toBe(true);
  });

  it("lists a corrupt default declaration as unavailable without hiding named ones", async () => {
    const root = await tempRoot();
    await declareWorkspace(root, { name: 42 });
    writeNamedWorkspaceDeclaration(root, "good", { name: "Good" });

    const [defaultSlot, named] = listWorkspaces(root);

    expect(defaultSlot).toMatchObject({ slug: undefined, name: undefined, declared: true });
    expect(defaultSlot?.problem).toMatch(/workspace\.json/);
    expect(named).toMatchObject({ slug: "good", name: "Good" });
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
