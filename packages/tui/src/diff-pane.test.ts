import { describe, expect, it } from "vitest";
import { type ChangedFile, type DiffSeams, FileChangeFeed } from "./diff-model.ts";
import { DiffPane } from "./diff-pane.ts";
import { parseChord } from "./keys.ts";
import type { PaneIntents } from "./pane.ts";
import { AppProbe } from "./probe.ts";
import { describePaneTree, dockOf, paneContext, paneIds } from "./testing/workflow-probe.ts";
import { parseWorkspaceState } from "./workspace-state.ts";

const inertIntents: PaneIntents = {
  openFile: () => {},
  openSession: () => {},
  focusPane: () => {},
};

function seamsOver(
  files: ChangedFile[],
  before: Record<string, string>,
  working: Record<string, string>,
): DiffSeams {
  return {
    baseline: {
      label: "session start",
      changes: async () => files,
      before: async (path) => before[path],
    },
    readFile: async (path) => working[path],
    changes: new FileChangeFeed(),
  };
}

function renderedText(pane: DiffPane): string[] {
  const texts: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const record = node as { content?: unknown; children?: unknown[] };
    if (typeof record.content === "string") texts.push(record.content);
    for (const child of record.children ?? []) walk(child);
  };
  walk(describePaneTree(pane.view(paneContext())));
  return texts;
}

describe("DiffPane", () => {
  it("titles itself with the file count and totals and lists files above the diff", async () => {
    const pane = new DiffPane(
      "diff-1",
      () => {},
      inertIntents,
      seamsOver(
        [
          { path: "notes.txt", added: 1, deleted: 1, turn: 2 },
          { path: "fresh.txt", added: 3, deleted: 0 },
        ],
        { "notes.txt": "alpha\nbeta\ngamma\n" },
        { "notes.txt": "alpha\nBETA\ngamma\n", "fresh.txt": "a\nb\nc\n" },
      ),
    );
    await pane.settled();
    expect(pane.title()).toBe(" diff · 2 files · +4 -1 ");
    const texts = renderedText(pane);
    expect(texts).toContainEqual(expect.stringContaining("notes.txt  +1 -1 · turn 2"));
    expect(texts).toContainEqual(expect.stringContaining("fresh.txt  +3 -0"));
    expect(texts).toContain("- beta");
    expect(texts).toContain("+ BETA");
    expect(pane.describe()).toEqual({ kind: "diff" });
  });

  it("reads as empty with the baseline named when nothing changed", async () => {
    const pane = new DiffPane("diff-1", () => {}, inertIntents, seamsOver([], {}, {}));
    await pane.settled();
    expect(pane.title()).toBe(" diff ");
    expect(renderedText(pane)).toContain("no changes since session start");
  });

  it("hands enter to the file intent with the first hunk line", async () => {
    const opened: unknown[] = [];
    const pane = new DiffPane(
      "diff-1",
      () => {},
      { ...inertIntents, openFile: (path, options) => opened.push({ path, options }) },
      seamsOver(
        [{ path: "notes.txt", added: 1, deleted: 1 }],
        { "notes.txt": "alpha\nbeta\ngamma\n" },
        { "notes.txt": "alpha\nBETA\ngamma\n" },
      ),
    );
    await pane.settled();
    expect(pane.handleKey(parseChord("enter"))).toBe(true);
    expect(opened).toEqual([{ path: "notes.txt", options: { line: 1 } }]);
  });
});

describe("diff pane in the app", () => {
  function probeWithDiff() {
    const built: string[] = [];
    const probe = new AppProbe({
      createDiffPane: (id) => {
        built.push(id);
        return {
          id,
          title: () => " diff ",
          view: () => {
            throw new Error("probe panes are never rendered");
          },
          describe: () => ({ kind: "diff" }),
        };
      },
    });
    return { probe, built };
  }

  it("opens docked right through /diff and focuses the same pane on leader g", () => {
    const { probe, built } = probeWithDiff();
    probe.command("diff");
    expect(paneIds(probe)).toEqual(["session-1", "diff-1"]);
    expect(dockOf(probe, "diff-1")).toBe("right");
    probe.core.focusPane("session-1");
    expect(probe.snapshot().focused).toBe("session-1");
    probe.keys("ctrl+k", "g");
    expect(probe.snapshot().focused).toBe("diff-1");
    expect(built).toEqual(["diff-1"]);
  });

  it("round-trips its descriptor through the workspace state", () => {
    const { probe } = probeWithDiff();
    probe.command("changes");
    const captured = probe.snapshot();
    const parsed = parseWorkspaceState({
      version: 2,
      layout: { tree: { kind: "leaf", id: "diff-1" }, focused: "diff-1" },
      panes: [{ id: "diff-1", kind: "diff" }],
      held: [],
    });
    expect(captured.panes.map((pane) => pane.id)).toContain("diff-1");
    expect(parsed?.panes).toEqual([{ id: "diff-1", kind: "diff" }]);
  });
});

describe("diff pane open-at-hunk through the app", () => {
  it("opens the selected file in a file pane after leader g focuses the diff", async () => {
    const opened: unknown[] = [];
    let pane: DiffPane | undefined;
    const probe = new AppProbe({
      createFilePane: (id, path, _notify, options) => {
        opened.push({ path, options });
        return {
          id,
          title: () => ` ${path} `,
          view: () => {
            throw new Error("probe panes are never rendered");
          },
        };
      },
      createDiffPane: (id, notify, intents) => {
        pane = new DiffPane(
          id,
          notify,
          intents,
          seamsOver(
            [{ path: "notes.txt", added: 1, deleted: 1 }],
            { "notes.txt": "alpha\nbeta\ngamma\n" },
            { "notes.txt": "alpha\nBETA\ngamma\n" },
          ),
        );
        return pane;
      },
    });
    probe.command("diff");
    await pane?.settled();
    probe.core.focusPane("session-1");
    probe.keys("ctrl+k", "g", "enter");
    expect(opened).toEqual([{ path: "notes.txt", options: { line: 1 } }]);
    expect(paneIds(probe)).toEqual(["session-1", "file-1", "diff-1"]);
  });
});
