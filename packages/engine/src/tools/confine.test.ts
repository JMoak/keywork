import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
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

function linkDirectory(target: string, path: string): void {
  symlinkSync(target, path, "junction");
}

const canLinkDirectories = probeDirectoryLinks();

function probeDirectoryLinks(): boolean {
  const probe = mkdtempSync(join(tmpdir(), "keywork-link-probe-"));
  try {
    mkdirSync(join(probe, "target"));
    linkDirectory(join(probe, "target"), join(probe, "link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

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

  it("resolves paths whose parents do not exist yet through the nearest existing ancestor", () => {
    expect(confinedPath(root, "brand/new/tree/file.txt")).toBe(
      join(root, "brand", "new", "tree", "file.txt"),
    );
    expect(() => confinedPath(root, "brand/new/../../../escape.txt")).toThrow("escapes");
  });

  it.skipIf(process.platform !== "win32")("rejects targets on another drive letter", () => {
    const otherDrive = root.toUpperCase().startsWith("C:") ? "D:" : "C:";
    const elsewhere = `${otherDrive}\\elsewhere\\file.txt`;
    expect(() => confinedPath(root, elsewhere)).toThrow("escapes the project root");
    expect(scopeContains(root, elsewhere)).toBe(false);
  });
});

describe("toolScope", () => {
  it("dedupes roots and always covers the working directory", () => {
    const scope = toolScope(root, [root, linked, linked]);
    expect(scope.roots).toEqual([root, linked]);
    expect(scopeCwd(scope)).toBe(root);
  });

  it("leaves a hand-built scope narrower than its cwd unwidened", () => {
    const narrow = { cwd: root, roots: [join(root, "sub")] };
    expect(scopeContains(narrow, join(root, "sub", "file.txt"))).toBe(true);
    expect(scopeContains(narrow, join(root, "elsewhere", "file.txt"))).toBe(false);
    expect(() => confinedPath(narrow, "elsewhere/file.txt")).toThrow("escapes");
    expect(scopeCwd(narrow)).toBe(root);
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

describe.skipIf(!canLinkDirectories)("links that leave the scope", () => {
  let escapeLink: string;

  beforeEach(async () => {
    escapeLink = join(root, "link");
    await writeFile(join(sibling, "secret.txt"), "TOPSECRET");
    linkDirectory(sibling, escapeLink);
  });

  it("rejects a link inside the root that points outside it", () => {
    expect(() => confinedPath(root, "link/secret.txt")).toThrow("escapes the project root");
    expect(scopeContains(root, join(escapeLink, "secret.txt"))).toBe(false);
    expect(scopeContains(root, escapeLink)).toBe(false);
  });

  it("rejects creating a file through the link even though the parent does not exist yet", () => {
    expect(() => confinedPath(root, "link/fresh/new.txt")).toThrow("escapes the project root");
  });

  it("keeps all three file tools out of the linked-away folder", async () => {
    await expect(readTool(root).execute({ path: "link/secret.txt" })).rejects.toThrow(/escapes/);
    await expect(
      writeTool(root).execute({ path: "link/planted.txt", content: "x" }),
    ).rejects.toThrow(/escapes/);
    await expect(
      editTool(root).execute({ path: "link/secret.txt", oldText: "TOP", newText: "x" }),
    ).rejects.toThrow(/escapes/);
    expect(await readFile(join(sibling, "secret.txt"), "utf8")).toBe("TOPSECRET");
  });

  it("still admits a link whose target lies inside the scope", async () => {
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "inside.txt"), "fine");
    linkDirectory(join(root, "sub"), join(root, "sub-link"));
    const scope = toolScope(root, [linked]);
    linkDirectory(linked, join(root, "linked-link"));

    expect(confinedPath(root, "sub-link/inside.txt")).toBe(join(root, "sub-link", "inside.txt"));
    expect(confinedPath(root, "sub-link/created/later.txt")).toBe(
      join(root, "sub-link", "created", "later.txt"),
    );
    expect(scopeContains(scope, join(root, "linked-link", "notes.md"))).toBe(true);
    expect(await readTool(root).execute({ path: "sub-link/inside.txt" })).toContain("fine");
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
