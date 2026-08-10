import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Checkpoints } from "./checkpoints.ts";

const cleanups: string[] = [];

async function scratchProject(): Promise<{ worktree: string; gitDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "keywork-checkpoints-"));
  cleanups.push(root);
  const worktree = join(root, "project");
  await mkdir(worktree);
  return { worktree, gitDir: join(root, "shadow") };
}

async function seed(worktree: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(worktree, name), content, "utf8");
  }
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const root = cleanups.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

describe("Checkpoints", () => {
  it("undoes edits, deletions, and new files back to the captured state", async () => {
    const { worktree, gitDir } = await scratchProject();
    const store = await Checkpoints.open({ worktree, gitDir });
    await seed(worktree, { "kept.txt": "original", "doomed.txt": "delete me" });

    await store.capture();
    await seed(worktree, { "kept.txt": "clobbered", "intruder.txt": "new" });
    await rm(join(worktree, "doomed.txt"));

    expect(await store.undo()).toBe(true);
    expect(await readFile(join(worktree, "kept.txt"), "utf8")).toBe("original");
    expect(await readFile(join(worktree, "doomed.txt"), "utf8")).toBe("delete me");
    expect(existsSync(join(worktree, "intruder.txt"))).toBe(false);
  });

  it("redoes an undone change and clears redo on the next capture", async () => {
    const { worktree, gitDir } = await scratchProject();
    const store = await Checkpoints.open({ worktree, gitDir });
    await seed(worktree, { "file.txt": "before" });

    await store.capture();
    await seed(worktree, { "file.txt": "after" });
    await store.undo();
    expect(await store.redo()).toBe(true);
    expect(await readFile(join(worktree, "file.txt"), "utf8")).toBe("after");

    await store.undo();
    await store.capture();
    expect(store.canRedo()).toBe(false);
    expect(await store.redo()).toBe(false);
  });

  it("reports nothing to undo before the first capture", async () => {
    const { worktree, gitDir } = await scratchProject();
    const store = await Checkpoints.open({ worktree, gitDir });

    expect(store.canUndo()).toBe(false);
    expect(await store.undo()).toBe(false);
  });

  it("leaves gitignored files alone in both directions", async () => {
    const { worktree, gitDir } = await scratchProject();
    const store = await Checkpoints.open({ worktree, gitDir });
    await seed(worktree, { ".gitignore": "secret.txt\n", "tracked.txt": "v1" });

    await store.capture();
    await seed(worktree, { "secret.txt": "untouchable", "tracked.txt": "v2" });
    await store.undo();

    expect(await readFile(join(worktree, "tracked.txt"), "utf8")).toBe("v1");
    expect(await readFile(join(worktree, "secret.txt"), "utf8")).toBe("untouchable");
  });

  it("bounds the undo ring at the configured limit", async () => {
    const { worktree, gitDir } = await scratchProject();
    const store = await Checkpoints.open({ worktree, gitDir, limit: 2 });

    for (const version of ["one", "two", "three"]) {
      await seed(worktree, { "file.txt": version });
      await store.capture();
    }
    await seed(worktree, { "file.txt": "final" });

    expect(await store.undo()).toBe(true);
    expect(await store.undo()).toBe(true);
    expect(await store.undo()).toBe(false);
    expect(await readFile(join(worktree, "file.txt"), "utf8")).toBe("two");
  });

  it("skips duplicate captures so undo always steps somewhere", async () => {
    const { worktree, gitDir } = await scratchProject();
    const store = await Checkpoints.open({ worktree, gitDir });
    await seed(worktree, { "file.txt": "same" });

    await store.capture();
    await store.capture();
    await seed(worktree, { "file.txt": "changed" });

    expect(await store.undo()).toBe(true);
    expect(await store.undo()).toBe(false);
  });

  it("never touches the project's own .git directory", async () => {
    const { worktree, gitDir } = await scratchProject();
    const store = await Checkpoints.open({ worktree, gitDir });
    const realGit = join(worktree, ".git");
    await mkdir(realGit);
    await writeFile(join(realGit, "marker"), "user repo state", "utf8");
    await seed(worktree, { "file.txt": "v1" });

    await store.capture();
    await seed(worktree, { "file.txt": "v2" });
    await store.undo();

    expect(await readFile(join(realGit, "marker"), "utf8")).toBe("user repo state");
    expect(await readFile(join(worktree, "file.txt"), "utf8")).toBe("v1");
  });

  it("reopens an existing shadow repo without reinitializing", async () => {
    const { worktree, gitDir } = await scratchProject();
    const first = await Checkpoints.open({ worktree, gitDir });
    await seed(worktree, { "file.txt": "v1" });
    await first.capture();

    const second = await Checkpoints.open({ worktree, gitDir });
    await seed(worktree, { "file.txt": "v2" });
    await second.capture();
    await seed(worktree, { "file.txt": "v3" });

    expect(await second.undo()).toBe(true);
    expect(await readFile(join(worktree, "file.txt"), "utf8")).toBe("v2");
  });
});
