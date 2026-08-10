import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Checkpoints, UnknownCheckpointError } from "./checkpoints.ts";

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

  it("ignores hostile repo-state env vars while keeping the rest of the environment", async () => {
    const { worktree, gitDir } = await scratchProject();
    const store = await Checkpoints.open({ worktree, gitDir });
    await seed(worktree, { "file.txt": "v1" });

    const hostile = {
      GIT_DIR: join(worktree, "nowhere"),
      GIT_WORK_TREE: join(worktree, "elsewhere"),
      GIT_OBJECT_DIRECTORY: join(worktree, "bogus-objects"),
    };
    const previous = Object.fromEntries(Object.keys(hostile).map((key) => [key, process.env[key]]));
    Object.assign(process.env, hostile);
    try {
      await store.capture();
      await seed(worktree, { "file.txt": "v2" });
      expect(await store.undo()).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(await readFile(join(worktree, "file.txt"), "utf8")).toBe("v1");
  });

  it("returns the captured tree hash, stable for identical content", async () => {
    const { worktree, gitDir } = await scratchProject();
    const store = await Checkpoints.open({ worktree, gitDir });
    await seed(worktree, { "file.txt": "v1" });

    const first = await store.captureTree();
    const repeat = await store.captureTree();
    await seed(worktree, { "file.txt": "v2" });
    const changed = await store.captureTree();

    expect(first).toMatch(/^[0-9a-f]{40,64}$/);
    expect(repeat).toBe(first);
    expect(changed).not.toBe(first);
  });

  it("restores files to a previously captured tree", async () => {
    const { worktree, gitDir } = await scratchProject();
    const store = await Checkpoints.open({ worktree, gitDir });
    await seed(worktree, { "kept.txt": "original", "doomed.txt": "delete me" });

    const tree = await store.captureTree();
    await seed(worktree, { "kept.txt": "clobbered", "intruder.txt": "new" });
    await rm(join(worktree, "doomed.txt"));
    await store.restoreTo(tree);

    expect(await readFile(join(worktree, "kept.txt"), "utf8")).toBe("original");
    expect(await readFile(join(worktree, "doomed.txt"), "utf8")).toBe("delete me");
    expect(existsSync(join(worktree, "intruder.txt"))).toBe(false);
  });

  it("rejects a malformed checkpoint reference without touching files", async () => {
    const { worktree, gitDir } = await scratchProject();
    const store = await Checkpoints.open({ worktree, gitDir });
    await seed(worktree, { "file.txt": "untouched" });

    await expect(store.restoreTo("--exec=evil")).rejects.toThrow(UnknownCheckpointError);
    expect(await readFile(join(worktree, "file.txt"), "utf8")).toBe("untouched");
  });

  it("rejects an unknown but well-formed tree hash without touching files", async () => {
    const { worktree, gitDir } = await scratchProject();
    const store = await Checkpoints.open({ worktree, gitDir });
    await seed(worktree, { "file.txt": "untouched" });
    await store.capture();

    await expect(store.restoreTo("a".repeat(40))).rejects.toThrow(UnknownCheckpointError);
    expect(await readFile(join(worktree, "file.txt"), "utf8")).toBe("untouched");
    expect(store.canRedo()).toBe(false);
    expect(store.canUndo()).toBe(true);
  });

  it("makes restoreTo undoable and clears redo", async () => {
    const { worktree, gitDir } = await scratchProject();
    const store = await Checkpoints.open({ worktree, gitDir });
    await seed(worktree, { "file.txt": "v1" });
    const v1 = await store.captureTree();
    await seed(worktree, { "file.txt": "v2" });
    await store.capture();
    await store.undo();

    expect(store.canRedo()).toBe(true);
    await seed(worktree, { "file.txt": "v3" });
    await store.restoreTo(v1);

    expect(store.canRedo()).toBe(false);
    expect(await readFile(join(worktree, "file.txt"), "utf8")).toBe("v1");
    expect(await store.undo()).toBe(true);
    expect(await readFile(join(worktree, "file.txt"), "utf8")).toBe("v3");
    expect(await store.redo()).toBe(true);
    expect(await readFile(join(worktree, "file.txt"), "utf8")).toBe("v1");
  });

  it("treats restoreTo onto the current state as a no-op", async () => {
    const { worktree, gitDir } = await scratchProject();
    const store = await Checkpoints.open({ worktree, gitDir });
    await seed(worktree, { "file.txt": "same" });
    const tree = await store.captureTree();

    await store.restoreTo(tree);

    expect(await readFile(join(worktree, "file.txt"), "utf8")).toBe("same");
    expect(await store.undo()).toBe(true);
    expect(await store.undo()).toBe(false);
  });

  it("serializes restoreTo behind an in-flight capture", async () => {
    const { worktree, gitDir } = await scratchProject();
    const store = await Checkpoints.open({ worktree, gitDir });
    await seed(worktree, { "file.txt": "v1" });
    const v1 = await store.captureTree();
    await seed(worktree, { "file.txt": "v2" });

    const order: string[] = [];
    const racingCapture = store.captureTree().then(() => order.push("capture"));
    const restore = store.restoreTo(v1).then(() => order.push("restore"));
    await Promise.all([racingCapture, restore]);

    expect(order).toEqual(["capture", "restore"]);
    expect(await readFile(join(worktree, "file.txt"), "utf8")).toBe("v1");
    expect(await store.undo()).toBe(true);
    expect(await readFile(join(worktree, "file.txt"), "utf8")).toBe("v2");
  });

  it("hands out the first captured tree per turn tag and clears on take", async () => {
    const { worktree, gitDir } = await scratchProject();
    const store = await Checkpoints.open({ worktree, gitDir });
    await seed(worktree, { "file.txt": "v1" });

    expect(store.takeTurnTag()).toBeUndefined();
    const first = await store.captureTree();
    await seed(worktree, { "file.txt": "v2" });
    await store.capture();

    expect(store.takeTurnTag()).toBe(first);
    expect(store.takeTurnTag()).toBeUndefined();
  });

  it("does not mint a turn tag from restoreTo or undo", async () => {
    const { worktree, gitDir } = await scratchProject();
    const store = await Checkpoints.open({ worktree, gitDir });
    await seed(worktree, { "file.txt": "v1" });
    const v1 = await store.captureTree();
    await seed(worktree, { "file.txt": "v2" });
    await store.capture();
    store.takeTurnTag();

    await store.undo();
    await store.restoreTo(v1);

    expect(store.takeTurnTag()).toBeUndefined();
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
