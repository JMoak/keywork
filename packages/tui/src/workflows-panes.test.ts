import { type SessionTreeNode, textMessage } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { BrowserPane } from "./browser-pane.ts";
import { ConversationPane } from "./conversation-pane.ts";
import { AppProbe } from "./probe.ts";
import { paneSessionIndex } from "./session-attachment.ts";
import { SessionTreePane, type SessionTreePort } from "./session-tree-pane.ts";
import type { SessionOverviewItem } from "./sessions-overview-model.ts";
import { dockedIds, mustParse, paneIds, stubFilePane } from "./testing/workflow-probe.ts";

describe("open file pane", () => {
  const fileProbe = () => new AppProbe({ createFilePane: (id, path) => stubFilePane(id, path) });

  it("/open <path> adds a file pane beside the session and focuses it", () => {
    const probe = fileProbe().type("/open src/app.ts").keys("enter");
    expect(paneIds(probe)).toEqual(["session-1", "file-1"]);
    expect(probe.snapshot().focused).toBe("file-1");
    expect(probe.snapshot().panes[1]?.title).toBe("src/app.ts");
  });
});

describe("file browser", () => {
  const listing: Record<string, { name: string; kind: "file" | "dir" }[]> = {
    ".": [
      { name: "src", kind: "dir" },
      { name: "readme.md", kind: "file" },
    ],
    src: [{ name: "app.ts", kind: "file" }],
  };
  const browserProbe = () =>
    new AppProbe({
      createFilePane: (id, path) => stubFilePane(id, path),
      createBrowserPane: (id, root, notify, intents) =>
        new BrowserPane(id, root, notify, intents, async (path) => {
          const entries = listing[path];
          if (entries === undefined) throw new Error(`no such directory: ${path}`);
          return entries;
        }),
      isDirectory: (path) => listing[path] !== undefined,
    });

  it("leader f summons the browser and refocuses it instead of duplicating", () => {
    const probe = browserProbe().keys("ctrl+k", "f");
    expect(paneIds(probe)).toEqual(["browser-1", "session-1"]);
    expect(probe.snapshot().focused).toBe("browser-1");
    probe.keys("ctrl+k", "l");
    expect(probe.snapshot().focused).toBe("session-1");
    probe.keys("f");
    expect(probe.snapshot().focused).toBe("browser-1");
    expect(paneIds(probe)).toEqual(["browser-1", "session-1"]);
  });

  it("enter on a file opens it into the main area and keeps the browser docked", async () => {
    const probe = browserProbe().type("/browse").keys("enter");
    await probe.settled();
    probe.keys("j", "enter");
    expect(paneIds(probe)).toEqual(["browser-1", "session-1", "file-1"]);
    expect(probe.snapshot().focused).toBe("file-1");
    expect(dockedIds(probe)).toEqual(["browser-1"]);
    expect(probe.snapshot().panes.find((pane) => pane.id === "file-1")?.title).toBe("readme.md");
  });

  it("/open <dir> redirects to the browser instead of a file pane", async () => {
    const probe = browserProbe().type("/open src").keys("enter");
    await probe.settled();
    expect(paneIds(probe)).toEqual(["browser-1", "session-1"]);
    expect(dockedIds(probe)).toEqual(["browser-1"]);
    expect(probe.snapshot().panes.find((pane) => pane.id === "browser-1")?.title).toContain("src");
  });
});

describe("session tree", () => {
  interface TreeWorld {
    entries: { id: string; parentId: string | null; text: string }[];
    labels: Map<string, string>;
    sessions: SessionOverviewItem[];
    forkedFrom: string[];
    resumed: (string | undefined)[];
    attached: string[];
  }

  const fixtureEntries = (): TreeWorld["entries"] => [
    { id: "u1", parentId: null, text: "hello" },
    { id: "a1", parentId: "u1", text: "hi there" },
    { id: "u2", parentId: "a1", text: "make a plan" },
    { id: "a2a", parentId: "u2", text: "plan v1" },
    { id: "a2b", parentId: "u2", text: "plan v2" },
  ];

  function rootsOf(world: TreeWorld): SessionTreeNode[] {
    const nodes = new Map<string, SessionTreeNode>(
      world.entries.map((entry) => [
        entry.id,
        {
          entry: {
            type: "message",
            id: entry.id,
            parentId: entry.parentId,
            timestamp: "",
            message: textMessage("user", entry.text),
          },
          children: [],
          onActivePath: entry.id !== "a2b",
          ...(world.labels.has(entry.id) && { label: world.labels.get(entry.id) as string }),
        },
      ]),
    );
    const roots: SessionTreeNode[] = [];
    for (const entry of world.entries) {
      const node = nodes.get(entry.id) as SessionTreeNode;
      const parent = entry.parentId === null ? undefined : nodes.get(entry.parentId);
      if (parent === undefined) roots.push(node);
      else parent.children.push(node);
    }
    return roots;
  }

  function overviewItemOf(id: string, modifiedAt: number, title = id): SessionOverviewItem {
    return {
      id,
      title,
      createdAt: modifiedAt,
      modifiedAt,
      entryCount: 5,
      branchCount: 1,
      labelCount: 1,
    };
  }

  function treeProbe() {
    const world: TreeWorld = {
      entries: fixtureEntries(),
      labels: new Map([["a2b", "alt"]]),
      sessions: [
        overviewItemOf("sess-session-1", 2, "hello"),
        overviewItemOf("idle-1", 1, "older work"),
      ],
      forkedFrom: [],
      resumed: [],
      attached: [],
    };
    const listeners: Array<(sessionId: string) => void> = [];
    const emit = (sessionId: string): void => {
      for (const listener of listeners) listener(sessionId);
    };
    const index = paneSessionIndex(undefined);
    const port: SessionTreePort = {
      overview: async () => [...world.sessions],
      load: async (sessionId) => ({ sessionId, name: "fixture", roots: rootsOf(world) }),
      setLabel: async (_sessionId, entryId, label) => {
        if (label === undefined) world.labels.delete(entryId);
        else world.labels.set(entryId, label);
      },
      fork: async (_sessionId, entryId) => {
        world.forkedFrom.push(entryId);
        const forkedId = `forked-${world.forkedFrom.length}`;
        world.sessions = [overviewItemOf(forkedId, 9, "forked"), ...world.sessions];
        emit(forkedId);
        return forkedId;
      },
      attach: async (sessionId) => {
        world.attached.push(sessionId);
        return true;
      },
      subscribe: (listener) => {
        listeners.push(listener);
        return () => {};
      },
    };
    const probe = new AppProbe({
      createPane: (id, notify, commands, resumeSessionId) => {
        world.resumed.push(resumeSessionId);
        const pane = new ConversationPane(id, undefined, notify, undefined, commands);
        pane.sessionId = resumeSessionId ?? `sess-${id}`;
        index.bind(id, () => pane.sessionId);
        return pane;
      },
      createSessionTreePane: (id, notify, intents, targetSession, sessionId) =>
        new SessionTreePane(id, notify, intents, port, targetSession, {
          ...(sessionId !== undefined && { sessionId }),
          presence: index,
        }),
      onPaneClosed: (id) => index.closed(id),
    });
    return { probe, world, emit, index };
  }

  function treePane(probe: AppProbe, id = "tree-1"): SessionTreePane {
    const pane = probe.core.panes.get(id);
    if (!(pane instanceof SessionTreePane)) throw new Error(`no session-tree pane "${id}"`);
    return pane;
  }

  async function drilledProbe() {
    const opened = treeProbe();
    opened.probe.command("tree");
    await opened.probe.settled();
    opened.probe.keys("l");
    await opened.probe.settled();
    return opened;
  }

  it("/tree opens the overview docked, focused, cursor on the focused conversation's row", async () => {
    const { probe } = treeProbe();
    probe.type("/tree").keys("enter");
    expect(paneIds(probe)).toEqual(["tree-1", "session-1"]);
    expect(dockedIds(probe)).toEqual(["tree-1"]);
    expect(probe.snapshot().focused).toBe("tree-1");
    await probe.settled();
    const pane = treePane(probe);
    expect(pane.level()).toBe("overview");
    expect(pane.overview.sessionRows().map((row) => [row.id, row.liveness])).toEqual([
      ["sess-session-1", "attached"],
      ["idle-1", "idle"],
    ]);
    expect(pane.overview.cursorSession()).toBe("sess-session-1");
    expect(probe.snapshot().panes.find((pane2) => pane2.id === "tree-1")?.title).toContain(
      "2 sessions",
    );
  });

  it("enter over an unpaned session opens a resumed pane in the main tree, then focuses it", async () => {
    const { probe, world } = treeProbe();
    probe.command("tree");
    await probe.settled();
    probe.keys("j", "enter");
    await probe.settled();
    expect(world.attached).toEqual(["idle-1"]);
    expect(world.resumed).toEqual([undefined, "idle-1"]);
    expect(paneIds(probe)).toEqual(["tree-1", "session-1", "session-2"]);
    expect(dockedIds(probe)).toEqual(["tree-1"]);
    expect(probe.snapshot().focused).toBe("session-2");
    probe.command("tree");
    probe.keys("enter");
    await probe.settled();
    expect(probe.snapshot().focused).toBe("session-2");
    expect(paneIds(probe)).toEqual(["tree-1", "session-1", "session-2"]);
  });

  it("f forks from the cursored node into a new conversation pane in the main area", async () => {
    const { probe, world } = await drilledProbe();
    probe.keys("j", "j", "f");
    await probe.settled();
    expect(world.forkedFrom).toEqual(["u2"]);
    expect(world.resumed).toEqual([undefined, "forked-1"]);
    expect(paneIds(probe)).toEqual(["tree-1", "session-1", "session-2"]);
    expect(dockedIds(probe)).toEqual(["tree-1"]);
    expect(probe.snapshot().focused).toBe("session-2");
  });

  it("persists as a session-tree pane and revives into the overview", async () => {
    const { probe } = await drilledProbe();
    const state = mustParse(probe.workspaceState());
    expect(state.panes).toContainEqual({
      id: "tree-1",
      kind: "session-tree",
      sessionId: "sess-session-1",
    });
    const restored = new AppProbe({
      createPane: (id, notify, commands) =>
        new ConversationPane(id, undefined, notify, undefined, commands),
      createSessionTreePane: (id, notify, intents, targetSession, sessionId) =>
        new SessionTreePane(
          id,
          notify,
          intents,
          {
            overview: async () => [overviewItemOf("sess-session-1", 1, "hello")],
            load: async (sessionId2) => ({ sessionId: sessionId2, roots: [] }),
            setLabel: async () => {},
            fork: async () => undefined,
          },
          targetSession,
          { ...(sessionId !== undefined && { sessionId }) },
        ),
      restoreWorkspace: state,
    });
    await restored.settled();
    expect(paneIds(restored)).toEqual(["tree-1", "session-1"]);
    const pane = treePane(restored);
    expect(pane.level()).toBe("overview");
    expect(pane.overview.sessionRows().map((row) => row.id)).toEqual(["sess-session-1"]);
    expect(pane.describe()).toEqual({ kind: "session-tree", sessionId: "sess-session-1" });
  });
});
