import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "./load.ts";
import {
  listWorkspaces,
  namedWorkspaceDir,
  writeNamedWorkspaceDeclaration,
} from "./named-workspaces.ts";
import { openWorkspace, resolveVaultPath } from "./workspace.ts";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-named-workspace-"));
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
