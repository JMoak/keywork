import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isMissingFileError, writeFileAtomic } from "./vault-files.ts";

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const root = cleanups.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

async function scratchDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "keywork-vault-files-"));
  cleanups.push(root);
  return root;
}

describe("writeFileAtomic", () => {
  it("creates missing parents, replaces existing content, and leaves no scratch file", async () => {
    const root = await scratchDir();
    const target = join(root, "nested", "deep", "note.md");
    await writeFileAtomic(target, "one\n");
    await writeFileAtomic(target, "two\n");
    expect(await readFile(target, "utf8")).toBe("two\n");
    expect(await readdir(join(root, "nested", "deep"))).toEqual(["note.md"]);
  });

  it("leaves the previous file intact when the scratch write cannot land", async () => {
    const root = await scratchDir();
    const target = join(root, "note.md");
    await writeFileAtomic(target, "kept\n");
    await expect(writeFileAtomic(join(target, "impossible.md"), "x\n")).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("kept\n");
    expect(await readdir(root)).toEqual(["note.md"]);
  });
});

describe("isMissingFileError", () => {
  it("recognizes only the two missing-path codes", () => {
    expect(isMissingFileError({ code: "ENOENT" })).toBe(true);
    expect(isMissingFileError({ code: "ENOTDIR" })).toBe(true);
    expect(isMissingFileError({ code: "EISDIR" })).toBe(false);
    expect(isMissingFileError({ code: "EACCES" })).toBe(false);
    expect(isMissingFileError(new Error("plain"))).toBe(false);
    expect(isMissingFileError(null)).toBe(false);
  });
});
