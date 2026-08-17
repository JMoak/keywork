import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { confinedPath, scopeContains, scopeCwd, toolScope } from "./confine.ts";
import { editTool } from "./edit.ts";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";

let scratch: string;
let root: string;
let linked: string;
let sibling: string;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "keywork-confine-"));
  root = join(scratch, "repo");
  linked = join(scratch, "linked");
  sibling = join(scratch, "sibling");
  await mkdir(root, { recursive: true });
  await mkdir(linked, { recursive: true });
  await mkdir(sibling, { recursive: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("confinedPath", () => {
  it("keeps the single-root behavior and message", () => {
    expect(confinedPath(root, "src/app.ts")).toBe(join(root, "src", "app.ts"));
    expect(() => confinedPath(root, "../outside.txt")).toThrow("escapes the project root");
  });

  it("admits paths inside a linked folder", () => {
    const scope = toolScope(root, [linked]);
    expect(confinedPath(scope, join(linked, "notes.md"))).toBe(join(linked, "notes.md"));
  });

  it("still confines siblings of a linked folder", () => {
    const scope = toolScope(root, [linked]);
    expect(() => confinedPath(scope, join(sibling, "secret.txt"))).toThrow(
      "escapes the workspace scope",
    );
  });

  it("resolves relative paths against the working directory", () => {
    const scope = toolScope(join(root, "packages"), [linked]);
    expect(confinedPath(scope, "app.ts")).toBe(join(root, "packages", "app.ts"));
  });
});

describe("toolScope", () => {
  it("dedupes roots and always covers the working directory", () => {
    const scope = toolScope(root, [root, linked, linked]);
    expect(scope.roots).toEqual([root, linked]);
    expect(scopeCwd(scope)).toBe(root);
  });
});

describe("scopeContains", () => {
  it("answers membership without throwing", () => {
    const scope = toolScope(root, [linked]);
    expect(scopeContains(scope, join(linked, "deep", "file.txt"))).toBe(true);
    expect(scopeContains(scope, join(sibling, "file.txt"))).toBe(false);
    expect(scopeContains(root, join(root, "file.txt"))).toBe(true);
  });
});

describe("file tools over a widened scope", () => {
  it("writes, edits, and reads inside the linked folder", async () => {
    const scope = toolScope(root, [linked]);
    const target = join(linked, "notes.md");
    await writeTool(scope).execute({ path: target, content: "alpha" });
    await editTool(scope).execute({ path: target, oldText: "alpha", newText: "beta" });
    expect(await readFile(target, "utf8")).toBe("beta");
    expect(await readTool(scope).execute({ path: target })).toContain("beta");
  });

  it("rejects sibling writes with the scope message", async () => {
    const scope = toolScope(root, [linked]);
    await expect(
      writeTool(scope).execute({ path: join(sibling, "out.txt"), content: "x" }),
    ).rejects.toThrow("escapes the workspace scope");
  });

  it("reports saved files to the tap", async () => {
    const saved: string[] = [];
    const scope = toolScope(root, [linked]);
    await writeTool(scope, (path) => saved.push(path)).execute({
      path: "a.txt",
      content: "one",
    });
    await writeFile(join(linked, "b.txt"), "two");
    await editTool(scope, (path) => saved.push(path)).execute({
      path: join(linked, "b.txt"),
      oldText: "two",
      newText: "three",
    });
    expect(saved).toEqual([join(root, "a.txt"), join(linked, "b.txt")]);
  });
});
