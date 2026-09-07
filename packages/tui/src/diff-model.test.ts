import { EventBus } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import {
  type ChangedFile,
  type DiffBaseline,
  DiffModel,
  type DiffSeams,
  FileChangeFeed,
  firstHunkLine,
  followMutations,
  gitHeadBaseline,
  noBaselineNotice,
  refreshingCheckpoints,
} from "./diff-model.ts";
import type { DiffLine } from "./diff-render.ts";
import { parseChord } from "./keys.ts";

interface World {
  before: Record<string, string>;
  working: Record<string, string>;
}

function baselineOver(world: World, listed: () => ChangedFile[]): DiffBaseline {
  return {
    label: "session start",
    changes: async () => listed(),
    before: async (path) => world.before[path],
  };
}

function changedFiles(world: World): ChangedFile[] {
  const paths = new Set([...Object.keys(world.before), ...Object.keys(world.working)]);
  return [...paths]
    .filter((path) => world.before[path] !== world.working[path])
    .sort()
    .map((path) => ({ path, added: 1, deleted: 1, turn: 1 }));
}

interface SeamOverrides {
  baseline?: DiffBaseline | undefined;
  unavailable?: string;
}

function modelOver(world: World, overrides?: SeamOverrides) {
  const feed = new FileChangeFeed();
  const opened: Array<{ path: string; line: number | undefined }> = [];
  let notified = 0;
  const baseline =
    overrides === undefined ? baselineOver(world, () => changedFiles(world)) : overrides.baseline;
  const seams: DiffSeams = {
    ...(baseline !== undefined && { baseline }),
    ...(overrides?.unavailable !== undefined && { unavailable: overrides.unavailable }),
    readFile: async (path) => world.working[path],
    changes: feed,
  };
  const model = new DiffModel(
    seams,
    () => {
      notified += 1;
    },
    (path, line) => opened.push({ path, line }),
  );
  return { model, feed, opened, notifications: () => notified };
}

function bodyText(model: DiffModel): string[] {
  const body = model.body();
  if (body.kind !== "diff") throw new Error(`expected a diff, saw ${body.kind}`);
  return body.lines.map((line) => `${line.kind}:${line.text}`);
}

const tenLines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");

describe("DiffModel", () => {
  it("shows a mock write in the file list and the diff on the next frame after the event", async () => {
    const world: World = { before: { "notes.txt": "alpha\nbeta\ngamma\n" }, working: {} };
    world.working["notes.txt"] = world.before["notes.txt"] ?? "";
    const { model, feed, notifications } = modelOver(world);
    await model.settled();
    expect(model.changedFiles()).toEqual([]);
    expect(model.body()).toEqual({ kind: "empty" });

    world.working["notes.txt"] = "alpha\nBETA\ngamma\n";
    const before = notifications();
    feed.emit();
    await model.settled();

    expect(notifications()).toBeGreaterThan(before);
    expect(model.changedFiles().map((file) => file.path)).toEqual(["notes.txt"]);
    expect(bodyText(model)).toEqual([
      "hunk:@@ -1,3 +1,3 @@",
      "context:alpha",
      "del:beta",
      "add:BETA",
      "context:gamma",
    ]);
  });

  it("walks files with j and k, loading each diff lazily and resetting the body scroll", async () => {
    const world: World = {
      before: { "a.txt": "one\n", "b.txt": "two\n" },
      working: { "a.txt": "uno\n", "b.txt": "dos\n" },
    };
    const { model } = modelOver(world);
    await model.settled();
    expect(model.cursorRow()?.path).toBe("a.txt");
    expect(bodyText(model)).toContain("add:uno");

    model.bodyScrollTop = 3;
    model.handleKey(parseChord("j"), 10);
    await model.settled();
    expect(model.cursorRow()?.path).toBe("b.txt");
    expect(model.bodyScrollTop).toBe(0);
    expect(bodyText(model)).toContain("add:dos");

    model.handleKey(parseChord("k"), 10);
    expect(model.cursorRow()?.path).toBe("a.txt");
    expect(bodyText(model)).toContain("add:uno");
  });

  it("opens the selected file at its first hunk on enter", async () => {
    const world: World = {
      before: { "long.txt": tenLines },
      working: { "long.txt": tenLines.replace("line 7", "LINE 7") },
    };
    const { model, opened } = modelOver(world);
    await model.settled();
    expect(model.handleKey(parseChord("enter"), 10)).toBe(true);
    expect(opened).toEqual([{ path: "long.txt", line: 5 }]);
  });

  it("refreshes after an undo announced through the checkpoints wrapper", async () => {
    const world: World = { before: { "notes.txt": "v1" }, working: { "notes.txt": "v2" } };
    const { model, feed } = modelOver(world);
    await model.settled();
    expect(model.changedFiles()).toHaveLength(1);

    const checkpoints = refreshingCheckpoints(
      {
        capture: async () => {},
        undo: async () => {
          world.working["notes.txt"] = "v1";
          return true;
        },
        redo: async () => false,
        restoreTo: async () => {},
      },
      feed,
    );
    expect(await checkpoints.undo()).toBe(true);
    await model.settled();
    expect(model.changedFiles()).toEqual([]);
    expect(model.body()).toEqual({ kind: "empty" });
  });

  it("bounds the rendered diff of a huge change and scrolls the body by pages", async () => {
    const huge = Array.from({ length: 5000 }, (_, index) => `row ${index}`).join("\n");
    const world: World = { before: {}, working: { "huge.txt": huge } };
    const { model } = modelOver(world);
    await model.settled();
    const lines = bodyText(model);
    expect(lines.length).toBeLessThanOrEqual(161);
    expect(lines[0]).toBe("note:new file");
    expect(lines.at(-1)).toMatch(/^note:… \d+ more diff lines …$/);

    expect(model.visibleBody(10)).toHaveLength(10);
    model.handleKey(parseChord("pagedown"), 10);
    expect(model.bodyScrollTop).toBe(10);
    model.handleKey(parseChord("ctrl+d"), 10);
    expect(model.bodyScrollTop).toBe(15);
    model.handleKey(parseChord("end"), 10);
    expect(model.visibleBody(10)).toHaveLength(10);
    expect(model.bodyScrollTop).toBe(lines.length - 10);
    model.handleKey(parseChord("home"), 10);
    expect(model.bodyScrollTop).toBe(0);
  });

  it("names the missing baseline instead of diffing", async () => {
    const { model } = modelOver({ before: {}, working: {} }, { baseline: undefined });
    await model.settled();
    expect(model.body()).toEqual({ kind: "unavailable", reason: noBaselineNotice });
    expect(model.handleKey(parseChord("r"), 10)).toBe(true);
    expect(model.changedFiles()).toEqual([]);
  });

  it("carries an untrusted notice verbatim", async () => {
    const { model } = modelOver(
      { before: {}, working: {} },
      { baseline: undefined, unavailable: "trust this folder first" },
    );
    expect(model.body()).toEqual({ kind: "unavailable", reason: "trust this folder first" });
  });

  it("surfaces a failing baseline read as a failure", async () => {
    const { model } = modelOver(
      { before: {}, working: {} },
      {
        baseline: {
          label: "HEAD",
          changes: async () => {
            throw new Error("git diff failed: not a repository");
          },
          before: async () => undefined,
        },
      },
    );
    await model.settled();
    expect(model.body()).toEqual({ kind: "failed", reason: "git diff failed: not a repository" });
  });

  it("re-reads the baseline on r and stops listening once disposed", async () => {
    let reads = 0;
    const world: World = { before: {}, working: {} };
    const { model, feed } = modelOver(world, {
      baseline: {
        label: "session start",
        changes: async () => {
          reads += 1;
          return [];
        },
        before: async () => undefined,
      },
    });
    await model.settled();
    expect(reads).toBe(1);
    model.handleKey(parseChord("r"), 10);
    await model.settled();
    expect(reads).toBe(2);
    model.dispose();
    feed.emit();
    await model.settled();
    expect(reads).toBe(2);
  });
});

describe("followMutations", () => {
  it("announces finished write and edit calls and ignores the rest", () => {
    const bus = new EventBus();
    const feed = new FileChangeFeed();
    let announced = 0;
    feed.subscribe(() => {
      announced += 1;
    });
    followMutations(bus, feed);
    const call = (callId: string, name: string) => ({
      type: "tool-call" as const,
      callId,
      name,
      arguments: {},
    });
    bus.emit("tool.started", { call: call("c1", "read") });
    bus.emit("tool.finished", { callId: "c1", output: "", isError: false });
    expect(announced).toBe(0);
    bus.emit("tool.started", { call: call("c2", "write") });
    bus.emit("tool.started", { call: call("c3", "edit") });
    bus.emit("tool.finished", { callId: "c2", output: "", isError: false });
    bus.emit("tool.finished", { callId: "c3", output: "", isError: true });
    expect(announced).toBe(2);
  });
});

describe("gitHeadBaseline", () => {
  it("lists tracked and untracked changes and reads HEAD content through the runner", async () => {
    const calls: string[][] = [];
    const runner = async (args: readonly string[]): Promise<string> => {
      calls.push([...args]);
      if (args[0] === "diff") return "1\t2\tsrc/a.ts\0-\t-\tlogo.png\0";
      if (args[0] === "ls-files") return "new.txt\0";
      if (args[0] === "show" && args[1] === "HEAD:src/a.ts") return "old\n";
      throw new Error(`git ${args[0]} failed`);
    };
    const baseline = gitHeadBaseline(runner, async (path) =>
      path === "new.txt" ? "x\ny\nz\n" : undefined,
    );
    expect(baseline.label).toBe("HEAD");
    expect(await baseline.changes()).toEqual([
      { path: "src/a.ts", added: 1, deleted: 2 },
      { path: "logo.png", added: 0, deleted: 0 },
      { path: "new.txt", added: 3, deleted: 0 },
    ]);
    expect(await baseline.before("src/a.ts")).toBe("old\n");
    expect(await baseline.before("new.txt")).toBeUndefined();
    expect(calls[0]).toEqual(["diff", "--numstat", "-z", "HEAD"]);
  });
});

describe("firstHunkLine", () => {
  it("reads the new-side start of the first hunk header", () => {
    const lines: DiffLine[] = [
      { kind: "note", text: "new file" },
      { kind: "hunk", text: "@@ -0,0 +1,3 @@" },
      { kind: "hunk", text: "@@ -8,2 +9,2 @@" },
    ];
    expect(firstHunkLine(lines)).toBe(1);
    expect(firstHunkLine([{ kind: "note", text: "no changes" }])).toBeUndefined();
  });
});
