import type { PathLike } from "node:fs";
import { mkdir, open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import {
  isMissingFileError,
  isVaultRelativePath,
  PathOutsideVaultError,
  VaultFiles,
  writeFileAtomic,
} from "./vault-files.ts";

const scratch = scratchDirs("keywork-vault-files-");

async function scratchDir(): Promise<string> {
  const root = await scratch();
  return root;
}

async function plant(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content, "utf8");
  }
}

describe("VaultFiles", () => {
  it("walks atomic and entity notes but never structure, hidden dirs, daily logs, or arcs", async () => {
    const root = await scratchDir();
    await plant(root, {
      "Note.md": "n",
      "entities/pkg/file.ts.md": "e",
      "MEMORY.md": "moc",
      "curation.md": "audit",
      "daily/2026-08-10.md": "d",
      "arcs/dock/Arc Note.md": "a",
      ".staging/x.md": "s",
      ".obsidian/app.md": "o",
      "MOC.md": "reserved file",
      "questions/Open.md": "reserved dir",
      "notes.txt": "not markdown",
    });
    const files = new VaultFiles(root, ["MOC.md", "questions/"]);
    expect(await files.walkNotes()).toEqual(["Note.md", "entities/pkg/file.ts.md"]);
    expect(await files.fileNames("questions")).toEqual(["Open.md"]);
    expect(await files.dirNames("arcs")).toEqual(["dock"]);
    expect(await files.fileNames("missing")).toEqual([]);
  });

  it("knows its reserved files and directories by vault-relative path only", () => {
    const files = new VaultFiles("/vault", ["MOC.md", "questions/"]);
    expect(files.isReserved("MOC.md")).toBe(true);
    expect(files.isReserved("questions/Open.md")).toBe(true);
    expect(files.isReservedDir("questions")).toBe(true);
    expect(files.isReserved("Note.md")).toBe(false);
    expect(files.isReserved("questions/../../x.md")).toBe(false);
    expect(files.isReservedDir("entities")).toBe(false);
  });

  it("reads, writes, and removes inside the root and refuses anything that escapes it", async () => {
    const root = await scratchDir();
    const files = new VaultFiles(root);
    expect(await files.read("Note.md")).toBeNull();
    await files.write("nested/Note.md", "one\n");
    expect(await files.read("nested/Note.md")).toBe("one\n");
    await files.remove("nested/Note.md");
    expect(await files.read("nested/Note.md")).toBeNull();
    for (const path of ["../outside.md", "/outside.md", ""]) {
      await expect(files.write(path, "x")).rejects.toBeInstanceOf(PathOutsideVaultError);
      await expect(files.read(path)).rejects.toBeInstanceOf(PathOutsideVaultError);
      await expect(files.remove(path)).rejects.toBeInstanceOf(PathOutsideVaultError);
    }
    expect(await readdir(join(root, ".."))).not.toContain("outside.md");
  });
});

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

  describe("over a file another handle holds", () => {
    function holdOf(code: string): Error {
      return Object.assign(new Error(`${code}: the file is held`), { code });
    }

    function renamesHeldFor(attempts: number, code: string, hold: Error = holdOf(code)) {
      let remaining = attempts;
      return {
        rename: async (from: PathLike, to: PathLike) => {
          if (remaining > 0) {
            remaining -= 1;
            throw hold;
          }
          await rename(from, to);
        },
      };
    }

    it.each(["EPERM", "EBUSY", "EACCES"])("rides out a transient %s on Windows", async (code) => {
      const root = await scratchDir();
      const target = join(root, "curation.md");
      await writeFileAtomic(target, "one\n");
      const pauses: number[] = [];

      await writeFileAtomic(target, "two\n", {
        disk: renamesHeldFor(2, code),
        pacing: {
          platform: "win32",
          pause: async (milliseconds) => {
            pauses.push(milliseconds);
          },
        },
      });

      expect(pauses).toHaveLength(2);
      expect(await readFile(target, "utf8")).toBe("two\n");
      expect(await readdir(root)).toEqual(["curation.md"]);
    });

    it("gives up with the first hold, keeps the prior file, and removes the scratch file", async () => {
      const root = await scratchDir();
      const target = join(root, "curation.md");
      await writeFileAtomic(target, "kept\n");
      const hold = holdOf("EPERM");

      await expect(
        writeFileAtomic(target, "lost\n", {
          disk: renamesHeldFor(Number.POSITIVE_INFINITY, "EPERM", hold),
          pacing: { platform: "win32", pause: async () => undefined },
        }),
      ).rejects.toBe(hold);

      expect(await readFile(target, "utf8")).toBe("kept\n");
      expect(await readdir(root)).toEqual(["curation.md"]);
    });

    it("surfaces a hold at once off Windows", async () => {
      const root = await scratchDir();
      const target = join(root, "curation.md");
      await writeFileAtomic(target, "kept\n");
      const pauses: number[] = [];

      await expect(
        writeFileAtomic(target, "lost\n", {
          disk: renamesHeldFor(1, "EPERM"),
          pacing: {
            platform: "linux",
            pause: async (milliseconds) => {
              pauses.push(milliseconds);
            },
          },
        }),
      ).rejects.toThrow("EPERM");

      expect(pauses).toEqual([]);
      expect(await readdir(root)).toEqual(["curation.md"]);
    });

    it.runIf(process.platform === "win32")(
      "replaces a target that a real handle holds, once the handle closes",
      async () => {
        const root = await scratchDir();
        const target = join(root, "curation.md");
        await writeFileAtomic(target, "one\n");
        const holder = await open(target, "r");
        const pauses: number[] = [];

        await writeFileAtomic(target, "two\n", {
          pacing: {
            pause: async (milliseconds) => {
              pauses.push(milliseconds);
              await holder.close();
            },
          },
        });

        expect(pauses).toHaveLength(1);
        expect(await readFile(target, "utf8")).toBe("two\n");
        expect(await readdir(root)).toEqual(["curation.md"]);
      },
    );
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

describe("isVaultRelativePath", () => {
  it("accepts plain relative paths and rejects every escape shape", () => {
    expect(isVaultRelativePath("Note.md")).toBe(true);
    expect(isVaultRelativePath("entities/pkg/file.ts.md")).toBe(true);
    for (const path of [
      "",
      "../x.md",
      "a/../b.md",
      "./x.md",
      "/x.md",
      "C:/x.md",
      "C:x.md",
      "\\\\srv\\x",
    ])
      expect(isVaultRelativePath(path)).toBe(false);
  });
});
