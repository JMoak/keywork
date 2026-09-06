import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Entry, ReadDirectory } from "./browser-model.ts";
import { BrowserPane } from "./browser-pane.ts";
import { parseChord } from "./keys.ts";
import type { PaneIntents } from "./pane.ts";
import { paneContext } from "./testing/workflow-probe.ts";
import { resolveTheme } from "./theme.ts";

const inertIntents: PaneIntents = {
  openFile: () => {},
  openSession: () => {},
  focusPane: () => {},
};

function heldDisk(): { read: ReadDirectory; release: (entries: Entry[]) => void } {
  let release: (entries: Entry[]) => void = () => {};
  const read: ReadDirectory = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  return { read, release: (entries) => release(entries) };
}

describe("BrowserPane disposal", () => {
  it("fires no notify once closed with a readdir still in flight", async () => {
    let notified = 0;
    const disk = heldDisk();
    const pane = new BrowserPane(
      "browser-1",
      "/workspace",
      () => {
        notified += 1;
      },
      inertIntents,
      disk.read,
    );
    pane.dispose();
    disk.release([{ name: "late.ts", kind: "file" }]);
    await pane.settled();
    expect(notified).toBe(0);
  });

  it("notifies when a read lands on a live pane", async () => {
    let notified = 0;
    const disk = heldDisk();
    const pane = new BrowserPane(
      "browser-1",
      "/workspace",
      () => {
        notified += 1;
      },
      inertIntents,
      disk.read,
    );
    disk.release([{ name: "here.ts", kind: "file" }]);
    await pane.settled();
    expect(notified).toBe(1);
    expect(pane.title()).toBe(" workspace · 1 entries ");
  });
});

describe("BrowserPane typed filter", () => {
  it("threads the raw sequence into the filter so a space and a capital survive", async () => {
    const pane = new BrowserPane(
      "browser-1",
      "/workspace",
      () => {},
      inertIntents,
      async () => [{ name: "My Notes.md", kind: "file" }],
    );
    await pane.settled();
    pane.handleKey(parseChord("/"), "/");
    pane.handleKey(parseChord("shift+m"), "M");
    pane.handleKey(parseChord("y"), "y");
    pane.handleKey(parseChord("space"), " ");
    expect(pane.handleKey(parseChord("ctrl+n"), "")).toBe(false);
    expect(pane.title()).toBe(" workspace · 1 entries ");
    pane.handleKey(parseChord("x"), "x");
    expect(pane.title()).toBe(" workspace ");
    expect(pane.describe()).toEqual({ kind: "browser", root: "/workspace" });
  });
});

describe("BrowserPane ignored entries", () => {
  it("paints .gitignore matches dim while leaving them openable", async () => {
    const opened: string[] = [];
    const listing: Record<string, Entry[]> = {
      "/workspace": [
        { name: ".gitignore", kind: "file" },
        { name: "dist", kind: "dir" },
        { name: "app.log", kind: "file" },
        { name: "main.ts", kind: "file" },
        { name: "zed.ts", kind: "file" },
      ],
    };
    const pane = new BrowserPane(
      "browser-1",
      "/workspace",
      () => {},
      { ...inertIntents, openFile: (path) => opened.push(path) },
      {
        readDirectory: async (path) => listing[path] ?? [],
        readIgnoreFile: async () => "dist/\n*.log\n",
      },
    );
    await pane.settled();
    const theme = resolveTheme();
    for (const spec of ["j", "j", "j"]) pane.handleKey(parseChord(spec), undefined);
    const view = pane.view({ ...paneContext(), theme, focused: false });
    expect(inkOf(view, "▸ dist")).toBe(theme.textDim);
    expect(inkOf(view, "  app.log")).toBe(theme.textDim);
    expect(inkOf(view, "  main.ts")).toBe(theme.text);
    for (const spec of ["k", "k"]) pane.handleKey(parseChord(spec), undefined);
    pane.handleKey(parseChord("enter"), undefined);
    expect(opened).toEqual([join("/workspace", "app.log")]);
  });
});

function inkOf(node: unknown, text: string): unknown {
  if (node === null || typeof node !== "object") return undefined;
  const record = node as { props?: { content?: unknown; fg?: unknown }; children?: unknown[] };
  if (record.props?.content === text) return record.props.fg;
  for (const child of record.children ?? []) {
    const found = inkOf(child, text);
    if (found !== undefined) return found;
  }
  return undefined;
}
