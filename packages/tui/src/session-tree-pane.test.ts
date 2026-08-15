import { type SessionTreeNode, textMessage } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { parseChord } from "./keys.ts";
import type { PaneIntents } from "./pane.ts";
import type { SessionTreeView } from "./session-tree-model.ts";
import { SessionTreePane, type SessionTreePort } from "./session-tree-pane.ts";

function nodeOf(id: string): SessionTreeNode {
  return {
    entry: {
      type: "message",
      id,
      parentId: null,
      timestamp: "",
      message: textMessage("user", id),
    },
    children: [],
    onActivePath: true,
  };
}

function viewOf(): SessionTreeView {
  return { sessionId: "s1", name: "fixture", roots: [nodeOf("a")] };
}

function intentsOver(opened: string[]): PaneIntents {
  return {
    openFile: () => {},
    openSession: (sessionId) => opened.push(sessionId),
    focusPane: () => {},
  };
}

describe("SessionTreePane", () => {
  it("opens the forked session once the fork lands", async () => {
    const opened: string[] = [];
    const port: SessionTreePort = {
      load: async () => viewOf(),
      setLabel: async () => {},
      fork: async () => "forked-1",
    };
    const pane = new SessionTreePane(
      "tree-1",
      () => {},
      intentsOver(opened),
      port,
      () => "s1",
    );
    await pane.settled();
    pane.handleKey(parseChord("f"));
    await pane.settled();
    expect(opened).toEqual(["forked-1"]);
  });

  it("a fork landing after dispose opens nothing and stays silent", async () => {
    const opened: string[] = [];
    let release: (id: string) => void = () => {};
    const port: SessionTreePort = {
      load: async () => viewOf(),
      setLabel: async () => {},
      fork: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    };
    let notified = 0;
    const pane = new SessionTreePane(
      "tree-1",
      () => {
        notified += 1;
      },
      intentsOver(opened),
      port,
      () => "s1",
    );
    await pane.settled();
    pane.handleKey(parseChord("f"));
    pane.dispose();
    const notifiedBefore = notified;
    release("forked-1");
    await pane.settled();
    expect(opened).toEqual([]);
    expect(notified).toBe(notifiedBefore);
  });

  it("starts no new work after dispose", async () => {
    let loads = 0;
    const port: SessionTreePort = {
      load: async () => {
        loads += 1;
        return viewOf();
      },
      setLabel: async () => {},
      fork: async () => undefined,
    };
    const pane = new SessionTreePane(
      "tree-1",
      () => {},
      intentsOver([]),
      port,
      () => "s1",
    );
    await pane.settled();
    pane.dispose();
    pane.refresh();
    await pane.settled();
    expect(loads).toBe(1);
  });
});
