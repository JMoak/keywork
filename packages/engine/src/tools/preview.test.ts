import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toolScope } from "./confine.ts";
import { editTool } from "./edit.ts";
import { previewCapBytes } from "./preview.ts";
import { writeTool } from "./write.ts";

const tempDirs: string[] = [];

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-preview-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("edit preview", () => {
  it("applies the edit to the file's current content without writing it", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "verbs.ts"), "split: 1,\nrotate: 2,\n");
    const preview = await editTool(toolScope(cwd)).preview?.({
      path: "src/verbs.ts",
      oldText: "rotate: 2",
      newText: "rotate: 3",
    });
    expect(preview).toEqual({
      path: "src/verbs.ts",
      before: "split: 1,\nrotate: 2,\n",
      after: "split: 1,\nrotate: 3,\n",
    });
    expect(await readFile(join(cwd, "src", "verbs.ts"), "utf8")).toBe("split: 1,\nrotate: 2,\n");
  });

  it("keeps the file's CRLF endings and honors replaceAll, exactly as the edit would", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "list.txt"), "a\r\nb\r\na\r\n");
    const preview = await editTool(toolScope(cwd)).preview?.({
      path: "list.txt",
      oldText: "a\n",
      newText: "z\n",
      replaceAll: true,
    });
    expect(preview?.after).toBe("z\r\nb\r\nz\r\n");
  });

  it("offers nothing when the edit would fail, the file is missing, binary or over the cap", async () => {
    const cwd = await workspace();
    const edit = editTool(toolScope(cwd));
    await writeFile(join(cwd, "twice.txt"), "x x");
    await writeFile(join(cwd, "blob.bin"), Buffer.from([104, 0, 105]));
    await writeFile(join(cwd, "huge.txt"), "y".repeat(previewCapBytes + 1));
    const previewOf = (path: string, oldText: string) =>
      edit.preview?.({ path, oldText, newText: "z" }).catch(() => "threw");
    expect(await previewOf("twice.txt", "x")).toBe("threw");
    expect(await previewOf("twice.txt", "absent")).toBe("threw");
    expect(await previewOf("missing.txt", "x")).toBeUndefined();
    expect(await previewOf("blob.bin", "h")).toBeUndefined();
    expect(await previewOf("huge.txt", "y")).toBeUndefined();
    expect(await edit.preview?.({ path: 3 })).toBeUndefined();
  });
});

describe("write preview", () => {
  it("shows a new file with no before and an existing one with its current content", async () => {
    const cwd = await workspace();
    const write = writeTool(toolScope(cwd));
    expect(await write.preview?.({ path: "notes/new.md", content: "hello\n" })).toEqual({
      path: "notes/new.md",
      before: null,
      after: "hello\n",
    });
    expect(existsSync(join(cwd, "notes"))).toBe(false);
    await writeFile(join(cwd, "old.md"), "before\n");
    expect(await write.preview?.({ path: "old.md", content: "after\n" })).toEqual({
      path: "old.md",
      before: "before\n",
      after: "after\n",
    });
  });

  it("names a path outside the working directory absolutely and offers nothing over the cap", async () => {
    const cwd = await workspace();
    const linked = await workspace();
    const write = writeTool(toolScope(cwd, [linked]));
    const outside = join(linked, "out.txt");
    expect((await write.preview?.({ path: outside, content: "x" }))?.path).toBe(outside);
    const oversized = "€".repeat(previewCapBytes / 3 + 1);
    expect(await write.preview?.({ path: "big.txt", content: oversized })).toBeUndefined();
  });
});
