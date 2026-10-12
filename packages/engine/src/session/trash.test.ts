import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { childDirFor } from "./children.ts";
import { spillDirFor } from "./spill.ts";
import { SessionFileCollisionError, SessionTrash, sessionFileSet } from "./trash.ts";

const tempDir = scratchDirs("keywork-session-trash-");

async function sessionOn(dir: string, name: string, spilled: boolean): Promise<string> {
  const file = join(dir, `${name}.jsonl`);
  await writeFile(file, '{"type":"session","id":"x"}\n', "utf8");
  if (spilled) {
    await mkdir(spillDirFor(file), { recursive: true });
    await writeFile(join(spillDirFor(file), "spill.txt"), "big output", "utf8");
  }
  return file;
}

async function withChild(file: string): Promise<string> {
  await mkdir(childDirFor(file), { recursive: true });
  const child = join(childDirFor(file), "3-0001-1.jsonl");
  await writeFile(child, '{"type":"session","id":"child"}\n', "utf8");
  return child;
}

describe("SessionTrash", () => {
  it("names a session's log, spill dir and child dir in one rule", () => {
    expect(sessionFileSet("/sessions/1-0001-9.jsonl")).toEqual({
      log: "/sessions/1-0001-9.jsonl",
      spills: join("/sessions", "1-0001-9.spills"),
      children: join("/sessions", "1-0001-9.children"),
    });
  });

  it("moves a parent's children with it and brings them back on restore", async () => {
    const dir = await tempDir();
    const parent = await sessionOn(dir, "1-0001-1", false);
    const child = await withChild(parent);
    const trash = new SessionTrash(dir);

    const trashed = await trash.put(parent);
    expect(existsSync(child)).toBe(false);
    expect(existsSync(join(childDirFor(trashed), "3-0001-1.jsonl"))).toBe(true);

    await trash.restore(trashed);
    expect(existsSync(child)).toBe(true);
  });

  it("discards a parent's children with it", async () => {
    const dir = await tempDir();
    const trash = new SessionTrash(dir);
    const parent = await sessionOn(dir, "1-0001-1", false);
    await withChild(parent);
    const trashed = await trash.put(parent);

    await trash.discard(trashed);
    expect(existsSync(childDirFor(trashed))).toBe(false);
  });

  it("moves the log and its spills into .trash together and lists only the logs", async () => {
    const dir = await tempDir();
    const spilled = await sessionOn(dir, "1-0001-1", true);
    const plain = await sessionOn(dir, "2-0001-1", false);
    const trash = new SessionTrash(dir);

    const trashedSpilled = await trash.put(spilled);
    const trashedPlain = await trash.put(plain);

    expect(trashedSpilled).toBe(join(dir, ".trash", "1-0001-1.jsonl"));
    expect(existsSync(spilled)).toBe(false);
    expect(existsSync(spillDirFor(spilled))).toBe(false);
    expect(existsSync(join(spillDirFor(trashedSpilled), "spill.txt"))).toBe(true);
    expect(existsSync(spillDirFor(trashedPlain))).toBe(false);
    expect(await trash.files()).toEqual([trashedSpilled, trashedPlain]);
    expect((await readdir(dir)).filter((name) => name.endsWith(".jsonl"))).toEqual([]);
  });

  it("restores the pair to the session dir and lists nothing when the trash is absent", async () => {
    const dir = await tempDir();
    const file = await sessionOn(dir, "1-0001-1", true);
    const trash = new SessionTrash(dir);
    expect(await trash.files()).toEqual([]);

    const trashed = await trash.put(file);
    expect(await trash.restore(trashed)).toBe(file);

    expect(existsSync(file)).toBe(true);
    expect(existsSync(join(spillDirFor(file), "spill.txt"))).toBe(true);
    expect(await trash.files()).toEqual([]);
  });

  it("refuses to overwrite at either end and moves nothing", async () => {
    const dir = await tempDir();
    const file = await sessionOn(dir, "1-0001-1", true);
    const trash = new SessionTrash(dir);
    await mkdir(trash.dir, { recursive: true });
    await writeFile(join(trash.dir, "1-0001-1.jsonl"), "older\n", "utf8");

    await expect(trash.put(file)).rejects.toBeInstanceOf(SessionFileCollisionError);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(spillDirFor(file))).toBe(true);

    const other = await sessionOn(dir, "2-0001-1", false);
    const trashed = await trash.put(other);
    await sessionOn(dir, "2-0001-1", false);
    await expect(trash.restore(trashed)).rejects.toBeInstanceOf(SessionFileCollisionError);
    expect(existsSync(trashed)).toBe(true);
  });

  it("purges every pair at once and discards one on its own", async () => {
    const dir = await tempDir();
    const trash = new SessionTrash(dir);
    const first = await trash.put(await sessionOn(dir, "1-0001-1", true));
    await trash.put(await sessionOn(dir, "2-0001-1", false));

    await trash.discard(first);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(spillDirFor(first))).toBe(false);
    expect(await trash.files()).toHaveLength(1);

    expect(await trash.purge()).toBe(1);
    expect(existsSync(trash.dir)).toBe(false);
    expect(await trash.purge()).toBe(0);
  });
});
