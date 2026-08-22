import { describe, expect, it } from "vitest";
import type { Entry, ReadDirectory } from "./browser-model.ts";
import { BrowserPane } from "./browser-pane.ts";
import { parseChord } from "./keys.ts";
import type { PaneIntents } from "./pane.ts";

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
