import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "./load.ts";
import {
  openWorkspace,
  resolveAnchor,
  updateWorkspaceDeclaration,
  type WorkspaceDeclaration,
  writeWorkspaceDeclaration,
} from "./workspace.ts";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-anchor-"));
  tempDirs.push(dir);
  return dir;
}

async function declareWorkspace(root: string, declaration: object): Promise<void> {
  await mkdir(join(root, ".keywork"), { recursive: true });
  await writeFile(join(root, ".keywork", "workspace.json"), JSON.stringify(declaration));
}

async function initGitRepo(root: string): Promise<void> {
  await mkdir(join(root, ".git"), { recursive: true });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("resolveAnchor", () => {
  it("anchors the git repo root from any subdirectory", async () => {
    const root = await tempRoot();
    await initGitRepo(root);
    const nested = join(root, "packages", "deep");
    await mkdir(nested, { recursive: true });

    expect(resolveAnchor(nested)).toEqual({ root, source: "git" });
  });

  it("lets an existing declaration win over the git root", async () => {
    const root = await tempRoot();
    await initGitRepo(root);
    await declareWorkspace(root, { name: "alpha" });

    expect(resolveAnchor(join(root))).toEqual({ root, source: "declaration" });
  });

  it("falls back to the launch directory when nothing anchors it", async () => {
    const dir = await tempRoot();

    expect(resolveAnchor(dir)).toEqual({ root: dir, source: "launch" });
  });

  it("rejects a nested anchor during resolution", async () => {
    const root = await tempRoot();
    await declareWorkspace(root, { name: "outer" });
    const inner = join(root, "sub");
    await mkdir(inner, { recursive: true });
    await declareWorkspace(inner, { name: "inner" });

    expect(() => resolveAnchor(inner)).toThrow("nested workspace anchors");
  });
});

describe("writeWorkspaceDeclaration", () => {
  it("writes a declaration the walk-up then discovers", async () => {
    const root = await tempRoot();
    writeWorkspaceDeclaration(root, { name: "alpha" });

    expect(openWorkspace(root)?.name).toBe("alpha");
  });

  it("refuses to create an anchor inside a declared workspace", async () => {
    const root = await tempRoot();
    await declareWorkspace(root, { name: "outer" });
    const inner = join(root, "sub");
    await mkdir(inner, { recursive: true });

    expect(() => writeWorkspaceDeclaration(inner, { name: "inner" })).toThrow(
      "nested workspace anchors",
    );
  });

  it("validates the declaration before writing", async () => {
    const root = await tempRoot();

    expect(() => writeWorkspaceDeclaration(root, { name: "" })).toThrow(ConfigError);
  });

  it("refuses to declare a workspace above an existing inner declaration", async () => {
    const root = await tempRoot();
    const inner = join(root, "packages", "deep");
    await mkdir(inner, { recursive: true });
    await declareWorkspace(inner, { name: "inner" });

    expect(() => writeWorkspaceDeclaration(root, { name: "outer" })).toThrow(ConfigError);
    expect(() => writeWorkspaceDeclaration(root, { name: "outer" })).toThrow(inner);
    expect(openWorkspace(root)).toBeUndefined();
    expect(openWorkspace(inner)?.name).toBe("inner");
  });

  it("ignores node_modules and .git when scanning below for inner declarations", async () => {
    const root = await tempRoot();
    const vendored = join(root, "node_modules", "dep");
    await mkdir(vendored, { recursive: true });
    await declareWorkspace(vendored, { name: "vendored" });

    writeWorkspaceDeclaration(root, { name: "outer" });

    expect(openWorkspace(root)?.name).toBe("outer");
  });
});

describe("updateWorkspaceDeclaration", () => {
  it("revises the declaration in place", async () => {
    const root = await tempRoot();
    writeWorkspaceDeclaration(root, { name: "alpha" });
    const linked = join(root, "..", "elsewhere");

    updateWorkspaceDeclaration(root, (declaration) => ({
      ...declaration,
      contextDirs: [linked],
    }));

    expect(openWorkspace(root)?.missingContextDirs).toEqual([join(root, "..", "elsewhere")]);
  });

  it("rejects a traversal slug before reading anything from disk", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "victim"), { recursive: true });
    await writeFile(join(root, "victim", "workspace.json"), JSON.stringify({ name: "victim" }));
    const traversal = "../../victim/.keywork/..";
    const revise = vi.fn((declaration: WorkspaceDeclaration) => declaration);

    expect(() => updateWorkspaceDeclaration(root, revise, traversal)).toThrow(ConfigError);
    expect(() => updateWorkspaceDeclaration(root, revise, traversal)).toThrow(
      /invalid workspace slug/,
    );
    expect(revise).not.toHaveBeenCalled();
  });
});
