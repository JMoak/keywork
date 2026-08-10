import {
  Agent,
  MockProvider,
  type SessionTreeNode,
  type Tool,
  textMessage,
  textTurn,
  toolCallTurn,
} from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { paletteFrame, paletteRowLimit } from "./app-core.ts";
import { BrowserPane } from "./browser-pane.ts";
import { ConversationPane } from "./conversation-pane.ts";
import { FileModel } from "./file-model.ts";
import type { Chord } from "./keys.ts";
import type { Pane } from "./pane.ts";
import { AppProbe } from "./probe.ts";
import type { SessionTreeModel } from "./session-tree-model.ts";
import { SessionTreePane, type SessionTreePort } from "./session-tree-pane.ts";
import { parseWorkspaceState, type WorkspaceState } from "./workspace-state.ts";

function mustParse(value: unknown): WorkspaceState {
  const state = parseWorkspaceState(value);
  if (state === undefined) throw new Error("expected a parseable workspace state");
  return state;
}

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1000;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

function paneIds(probe: AppProbe): string[] {
  return probe.snapshot().panes.map((pane) => pane.id);
}

function stubFilePane(id: string, path: string, handleKey?: (chord: Chord) => boolean): Pane {
  return {
    id,
    title: () => ` ${path} `,
    view: () => {
      throw new Error("probe panes are never rendered");
    },
    ...(handleKey !== undefined && { handleKey }),
  };
}

function dockedIds(probe: AppProbe): string[] {
  return probe
    .snapshot()
    .panes.filter((pane) => pane.docked)
    .map((pane) => pane.id);
}

describe("boot", () => {
  it("starts with a single focused pane", () => {
    const probe = new AppProbe();
    const snapshot = probe.snapshot();
    expect(paneIds(probe)).toEqual(["session-1"]);
    expect(snapshot.focused).toBe("session-1");
    expect(snapshot.panes[0]?.focused).toBe(true);
    expect(probe.exited).toBe(false);
  });
});

describe("split and sticky navigation", () => {
  it("splits twice from a single leader press", () => {
    const probe = new AppProbe().keys("ctrl+k", "s", "s");
    expect(paneIds(probe)).toEqual(["session-1", "session-2", "session-3"]);
    expect(probe.snapshot().focused).toBe("session-3");
    expect(probe.snapshot().leaderArmed).toBe(true);
  });

  it("traverses h/l/j/k in one sticky chain", () => {
    const probe = new AppProbe().keys("ctrl+k", "s", "s", "h");
    expect(probe.snapshot().focused).toBe("session-1");
    probe.keys("l");
    expect(probe.snapshot().focused).toBe("session-2");
    probe.keys("j");
    expect(probe.snapshot().focused).toBe("session-3");
    probe.keys("k");
    expect(probe.snapshot().focused).toBe("session-2");
  });
});

describe("docking", () => {
  it("docks, stacks a second pane, undocks, and re-docks right", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.command("split");

    probe.keys("ctrl+k", "d");
    expect(probe.snapshot().dockSide).toBe("left");
    expect(dockedIds(probe)).toEqual(["session-3"]);

    probe.keys("l", "d");
    expect(dockedIds(probe)).toEqual(["session-3", "session-1"]);

    probe.keys("u");
    expect(dockedIds(probe)).toEqual(["session-3"]);
    expect(paneIds(probe)).toContain("session-1");

    probe.keys("shift+d");
    expect(probe.snapshot().dockSide).toBe("right");
  });
});

describe("zoom", () => {
  it("toggles zoom on the focused pane and back", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.keys("ctrl+k", "z");
    expect(probe.snapshot().zoomed).toBe("session-2");
    probe.keys("z");
    expect(probe.snapshot().zoomed).toBeUndefined();
  });
});

describe("command palette", () => {
  it("opens, takes a query, and runs the top match on enter", () => {
    const probe = new AppProbe().keys("ctrl+p");
    expect(probe.snapshot().overlay).toBe("palette");

    probe.type("split");
    expect(probe.snapshot().paletteQuery).toBe("split");

    probe.keys("enter");
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(paneIds(probe)).toEqual(["session-1", "session-2"]);
  });

  it("closes on escape without running anything", () => {
    const probe = new AppProbe().keys("ctrl+p").type("split").keys("escape");
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(paneIds(probe)).toEqual(["session-1"]);
  });

  it("hides arg-requiring commands from the palette but keeps them for slash input", () => {
    const probe = new AppProbe({ createFilePane: (id, path) => stubFilePane(id, path) });
    probe.keys("ctrl+p").type("open");
    expect(probe.core.paletteMatches().map((entry) => entry.name)).not.toContain("open");
    probe.keys("escape");
    expect(probe.core.registry.search("open").map((entry) => entry.name)).toContain("open");
  });

  it("keeps the matched entries stable when a pane retitles mid-selection", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.keys("ctrl+p").type("go");
    const before = probe.core.paletteMatches();
    expect(before.some((entry) => entry.name === "go-session-1")).toBe(true);

    const idle = probe.core.panes.get("session-1");
    if (idle !== undefined) idle.title = () => " renamed pane ";

    expect(probe.core.paletteMatches()).toBe(before);
    probe.keys("enter");
    expect(probe.snapshot().focused).toBe("session-1");
  });
});

describe("slash commands", () => {
  it("/exit closes the focused pane while others remain", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.type("/exit").keys("enter");
    expect(paneIds(probe)).toEqual(["session-1"]);
    expect(probe.exited).toBe(false);
  });

  it("/exit from the last pane quits the app", () => {
    const probe = new AppProbe().type("/exit").keys("enter");
    expect(probe.exited).toBe(true);
  });

  it("/exit-all quits immediately from any pane", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.type("/exit-all").keys("enter");
    expect(probe.exited).toBe(true);
  });
});

describe("closing panes via keys", () => {
  it("closes one of several panes and keeps the app running", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.keys("ctrl+k", "x");
    expect(paneIds(probe)).toEqual(["session-1"]);
    expect(probe.exited).toBe(false);
  });

  it("quits from the last pane, matching /exit", () => {
    const probe = new AppProbe().keys("ctrl+k", "x");
    expect(probe.exited).toBe(true);
  });

  it("closing a busy pane interrupts its agent and detaches its transcript", async () => {
    const agents: Agent[] = [];
    const probe = new AppProbe({
      createPane: (id, notify, commands) => {
        const agent = new Agent({ provider: new MockProvider([textTurn("reply")]) });
        agents.push(agent);
        return new ConversationPane(id, agent, notify, undefined, commands);
      },
    });
    probe.command("split");
    probe.type("go").keys("enter");
    const closing = probe.model();
    expect(closing?.busy).toBe(true);
    const busyAgent = agents.find((agent) => agent.busy());
    expect(busyAgent).toBeDefined();

    probe.keys("ctrl+k", "x");

    expect(probe.exited).toBe(false);
    expect(paneIds(probe)).toEqual(["session-1"]);
    await waitFor(() => expect(busyAgent?.busy()).toBe(false));
    expect(closing?.entries).toEqual([{ kind: "user", text: "go" }]);
    expect(closing?.busy).toBe(false);
  });
});

describe("sticky chain boundaries", () => {
  it("disarms on a second ctrl+k instead of acting as leader k", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.keys("ctrl+k", "s", "ctrl+k");
    expect(probe.snapshot().leaderArmed).toBe(false);
    expect(probe.snapshot().focused).toBe("session-3");
  });

  it("lets / start slash input after a sticky action instead of opening help", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.keys("ctrl+k", "h", "/");
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(probe.model()?.input).toBe("/");
  });

  it("still opens help from a fresh leader /", () => {
    const probe = new AppProbe().keys("ctrl+k", "/");
    expect(probe.snapshot().overlay).toBe("help");
  });
});

describe("splitting from a docked pane", () => {
  it("opens the new session into the main tree, not the dock", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.keys("ctrl+k", "d");
    expect(dockedIds(probe)).toEqual(["session-2"]);

    probe.keys("s");
    expect(dockedIds(probe)).toEqual(["session-2"]);
    expect(paneIds(probe)).toEqual(["session-1", "session-3", "session-2"]);
    expect(probe.snapshot().focused).toBe("session-3");
  });

  it("lands in the main area even when every pane is docked", () => {
    const probe = new AppProbe().keys("ctrl+k", "d");
    expect(dockedIds(probe)).toEqual(["session-1"]);

    probe.keys("s");
    expect(dockedIds(probe)).toEqual(["session-1"]);
    expect(paneIds(probe)).toEqual(["session-2", "session-1"]);
  });
});

describe("modified chords while the leader is armed", () => {
  it("does not close a pane on ctrl+x during an armed leader", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.keys("ctrl+k", "ctrl+x");
    expect(paneIds(probe)).toEqual(["session-1", "session-2"]);
    expect(probe.exited).toBe(false);
  });

  it("does not split on ctrl+s or alt+s during an armed leader", () => {
    const probe = new AppProbe().keys("ctrl+k", "ctrl+s");
    expect(paneIds(probe)).toEqual(["session-1"]);
    probe.keys("ctrl+k", "alt+s");
    expect(paneIds(probe)).toEqual(["session-1"]);
  });

  it("keeps a held leader armed through key-repeat without toggling", () => {
    const probe = new AppProbe().keys("ctrl+k").repeat("ctrl+k").repeat("ctrl+k");
    expect(probe.snapshot().leaderArmed).toBe(true);
    probe.keys("s");
    expect(paneIds(probe)).toEqual(["session-1", "session-2"]);
  });
});

describe("paste", () => {
  it("routes pasted text into the focused pane's prompt without submitting", () => {
    const probe = new AppProbe().type("see: ").paste("first line\nsecond line");
    expect(probe.model()?.input).toBe("see: first line\nsecond line");
    expect(probe.model()?.entries.filter((entry) => entry.kind === "user")).toEqual([]);
  });

  it("drops pastes while an overlay is open", () => {
    const probe = new AppProbe().keys("ctrl+p").paste("split");
    expect(probe.snapshot().paletteQuery).toBe("");
    probe.keys("escape");
    expect(probe.model()?.input).toBe("");
  });
});

describe("modal help overlay", () => {
  it("swallows keys while open instead of leaking them to panes", () => {
    const probe = new AppProbe().keys("ctrl+k", "/");
    expect(probe.snapshot().overlay).toBe("help");
    probe.keys("s").type("hello");
    expect(probe.snapshot().overlay).toBe("help");
    expect(paneIds(probe)).toEqual(["session-1"]);
    expect(probe.model()?.input).toBe("");
  });

  it("closes on escape and on f1", () => {
    const probe = new AppProbe().keys("ctrl+k", "/", "escape");
    expect(probe.snapshot().overlay).toBeUndefined();
    probe.keys("f1");
    expect(probe.snapshot().overlay).toBe("help");
    probe.keys("f1");
    expect(probe.snapshot().overlay).toBeUndefined();
  });

  it("still quits from ctrl+q while help is open", () => {
    const probe = new AppProbe().keys("ctrl+k", "/", "ctrl+q");
    expect(probe.exited).toBe(true);
  });
});

describe("armed indicator expiry", () => {
  it("clears leaderArmed once the keymap's arm window lapses", () => {
    const probe = new AppProbe().keys("ctrl+k");
    expect(probe.snapshot().leaderArmed).toBe(true);

    probe.core.expireArmed(10_000);
    expect(probe.snapshot().leaderArmed).toBe(false);
  });
});

describe("jump commands", () => {
  it("lists a go-<session> entry for each unfocused pane and jumps on run", () => {
    const probe = new AppProbe();
    probe.command("split");
    const jump = probe.core.registry.search("go").find((entry) => entry.name.startsWith("go-"));
    expect(jump?.name).toBe("go-session-1");
    expect(probe.command("go-session-1")).toBe(true);
    expect(probe.snapshot().focused).toBe("session-1");
  });

  it("runs go commands whose titles contain spaces", () => {
    const probe = new AppProbe({
      createFilePane: (id, path) => stubFilePane(id, path),
    });
    probe.type("/open my notes.txt").keys("enter");
    expect(probe.snapshot().focused).toBe("file-1");
    probe.command("split");
    const jump = probe.core.registry.search("go").find((entry) => entry.name.startsWith("go-my"));
    expect(jump?.name).toBe("go-my notes.txt");
    expect(probe.command("go-my notes.txt")).toBe(true);
    expect(probe.snapshot().focused).toBe("file-1");
  });

  it("gives duplicate titles distinct go commands that jump to each pane", () => {
    const probe = new AppProbe({
      createFilePane: (id, path) => stubFilePane(id, path),
    });
    probe.type("/open notes.txt").keys("enter");
    probe.command("go-session-1");
    probe.type("/open notes.txt").keys("enter");
    probe.command("go-session-1");
    const names = probe.core.registry
      .search("go")
      .map((entry) => entry.name)
      .filter((name) => name.startsWith("go-notes"));
    expect(names.sort()).toEqual(["go-notes.txt file-1", "go-notes.txt file-2"]);
    expect(probe.command("go-notes.txt file-2")).toBe(true);
    expect(probe.snapshot().focused).toBe("file-2");
  });
});

describe("open file pane", () => {
  const fileProbe = () => new AppProbe({ createFilePane: (id, path) => stubFilePane(id, path) });

  it("/open <path> adds a file pane beside the session and focuses it", () => {
    const probe = fileProbe().type("/open src/app.ts").keys("enter");
    expect(paneIds(probe)).toEqual(["session-1", "file-1"]);
    expect(probe.snapshot().focused).toBe("file-1");
    expect(probe.snapshot().panes[1]?.title).toBe("src/app.ts");
  });

  it("/open without a path does nothing", () => {
    const probe = fileProbe().type("/open").keys("enter");
    expect(paneIds(probe)).toEqual(["session-1"]);
  });

  it("open is absent when no file pane factory is wired", () => {
    expect(new AppProbe().command("open src/app.ts")).toBe(false);
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

  it("/browse opens the browser docked left and focused", () => {
    const probe = browserProbe().type("/browse").keys("enter");
    expect(paneIds(probe)).toEqual(["session-1", "browser-1"]);
    expect(dockedIds(probe)).toEqual(["browser-1"]);
    expect(probe.snapshot().dockSide).toBe("left");
    expect(probe.snapshot().focused).toBe("browser-1");
  });

  it("leader f summons the browser and refocuses it instead of duplicating", () => {
    const probe = browserProbe().keys("ctrl+k", "f");
    expect(paneIds(probe)).toEqual(["session-1", "browser-1"]);
    expect(probe.snapshot().focused).toBe("browser-1");
    probe.keys("ctrl+k", "l");
    expect(probe.snapshot().focused).toBe("session-1");
    probe.keys("f");
    expect(probe.snapshot().focused).toBe("browser-1");
    expect(paneIds(probe)).toEqual(["session-1", "browser-1"]);
  });

  it("enter on a file opens it into the main area and keeps the browser docked", async () => {
    const probe = browserProbe().type("/browse").keys("enter");
    await probe.settled();
    probe.keys("j", "enter");
    expect(paneIds(probe)).toEqual(["session-1", "file-1", "browser-1"]);
    expect(probe.snapshot().focused).toBe("file-1");
    expect(dockedIds(probe)).toEqual(["browser-1"]);
    expect(probe.snapshot().panes.find((pane) => pane.id === "file-1")?.title).toBe("readme.md");
  });

  it("/open <dir> redirects to the browser instead of a file pane", async () => {
    const probe = browserProbe().type("/open src").keys("enter");
    await probe.settled();
    expect(paneIds(probe)).toEqual(["session-1", "browser-1"]);
    expect(dockedIds(probe)).toEqual(["browser-1"]);
    expect(probe.snapshot().panes.find((pane) => pane.id === "browser-1")?.title).toContain("src");
  });

  it("browse is absent when no browser factory is wired", () => {
    expect(new AppProbe().command("browse")).toBe(false);
  });
});

describe("session tree", () => {
  interface TreeWorld {
    entries: { id: string; parentId: string | null; text: string }[];
    labels: Map<string, string>;
    forkedFrom: string[];
    resumed: (string | undefined)[];
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

  function treeProbe() {
    const world: TreeWorld = {
      entries: fixtureEntries(),
      labels: new Map([["a2b", "alt"]]),
      forkedFrom: [],
      resumed: [],
    };
    const port: SessionTreePort = {
      load: async (sessionId) => ({ sessionId, name: "fixture", roots: rootsOf(world) }),
      setLabel: async (_sessionId, entryId, label) => {
        if (label === undefined) world.labels.delete(entryId);
        else world.labels.set(entryId, label);
      },
      fork: async (_sessionId, entryId) => {
        world.forkedFrom.push(entryId);
        return `forked-${world.forkedFrom.length}`;
      },
    };
    const probe = new AppProbe({
      createPane: (id, notify, commands, resumeSessionId) => {
        world.resumed.push(resumeSessionId);
        const pane = new ConversationPane(id, undefined, notify, undefined, commands);
        pane.sessionId = resumeSessionId ?? `sess-${id}`;
        return pane;
      },
      createSessionTreePane: (id, notify, intents, targetSession, sessionId) =>
        new SessionTreePane(id, notify, intents, port, targetSession, sessionId),
    });
    return { probe, world };
  }

  function treeModel(probe: AppProbe, id = "tree-1"): SessionTreeModel {
    const pane = probe.core.panes.get(id);
    if (!(pane instanceof SessionTreePane)) throw new Error(`no session-tree pane "${id}"`);
    return pane.model;
  }

  it("/tree opens the tree docked, focused, and mapped to the focused conversation", async () => {
    const { probe } = treeProbe();
    probe.type("/tree").keys("enter");
    expect(paneIds(probe)).toEqual(["session-1", "tree-1"]);
    expect(dockedIds(probe)).toEqual(["tree-1"]);
    expect(probe.snapshot().focused).toBe("tree-1");
    await probe.settled();
    expect(treeModel(probe).sessionId()).toBe("sess-session-1");
    expect(probe.snapshot().panes.find((pane) => pane.id === "tree-1")?.title).toContain(
      "5 entries",
    );
  });

  it("leader t summons the tree and refocuses it instead of duplicating", () => {
    const { probe } = treeProbe();
    probe.keys("ctrl+k", "t");
    expect(paneIds(probe)).toEqual(["session-1", "tree-1"]);
    expect(probe.snapshot().focused).toBe("tree-1");
    probe.keys("ctrl+k", "l");
    expect(probe.snapshot().focused).toBe("session-1");
    probe.keys("t");
    expect(probe.snapshot().focused).toBe("tree-1");
    expect(paneIds(probe)).toEqual(["session-1", "tree-1"]);
  });

  it("renders branch structure and navigates with j/k", async () => {
    const { probe } = treeProbe();
    probe.command("tree");
    await probe.settled();
    const model = treeModel(probe);
    expect(model.rows().map((row) => [row.id, row.depth])).toEqual([
      ["u1", 0],
      ["a1", 0],
      ["u2", 0],
      ["a2a", 1],
      ["a2b", 1],
    ]);
    probe.keys("j", "j");
    expect(model.cursorRow()?.id).toBe("u2");
    probe.keys("k");
    expect(model.cursorRow()?.id).toBe("a1");
  });

  it("f forks from the cursored node into a new conversation pane in the main area", async () => {
    const { probe, world } = treeProbe();
    probe.command("tree");
    await probe.settled();
    probe.keys("j", "j", "f");
    await probe.settled();
    expect(world.forkedFrom).toEqual(["u2"]);
    expect(world.resumed).toEqual([undefined, "forked-1"]);
    expect(paneIds(probe)).toEqual(["session-1", "session-2", "tree-1"]);
    expect(dockedIds(probe)).toEqual(["tree-1"]);
    expect(probe.snapshot().focused).toBe("session-2");
  });

  it("labels round-trip: shift+l edits, enter commits, the reloaded tree shows it", async () => {
    const { probe, world } = treeProbe();
    probe.command("tree");
    await probe.settled();
    probe.keys("j", "shift+l").type("wip").keys("enter");
    await probe.settled();
    expect(world.labels.get("a1")).toBe("wip");
    expect(treeModel(probe).cursorRow()?.label).toBe("wip");
    probe.keys("shift+l", "backspace", "backspace", "backspace", "enter");
    await probe.settled();
    expect(world.labels.has("a1")).toBe(false);
    expect(treeModel(probe).cursorRow()?.label).toBeUndefined();
  });

  it("r refreshes and keeps the cursor on the surviving entry", async () => {
    const { probe, world } = treeProbe();
    probe.command("tree");
    await probe.settled();
    probe.keys("j", "j");
    world.entries.push({ id: "u0", parentId: null, text: "second root" });
    probe.keys("r");
    await probe.settled();
    const model = treeModel(probe);
    expect(model.rows()).toHaveLength(6);
    expect(model.cursorRow()?.id).toBe("u2");
  });

  it("a refresh that deletes the cursored node clamps to the nearest row", async () => {
    const { probe, world } = treeProbe();
    probe.command("tree");
    await probe.settled();
    probe.keys("j", "j", "j", "j");
    expect(treeModel(probe).cursorRow()?.id).toBe("a2b");
    world.entries = world.entries.filter((entry) => entry.id !== "a2b");
    probe.keys("r");
    await probe.settled();
    const model = treeModel(probe);
    expect(model.rows()).toHaveLength(4);
    expect(model.cursorRow()).toBeDefined();
  });

  it("persists as a session-tree pane and revives from workspace state", async () => {
    const { probe } = treeProbe();
    probe.command("tree");
    await probe.settled();
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
            load: async (sessionId2) => ({ sessionId: sessionId2, roots: [] }),
            setLabel: async () => {},
            fork: async () => undefined,
          },
          targetSession,
          sessionId,
        ),
      restoreWorkspace: state,
    });
    await restored.settled();
    expect(paneIds(restored)).toEqual(["session-1", "tree-1"]);
    expect(treeModel(restored).sessionId()).toBe("sess-session-1");
  });

  it("tree is absent when no session-tree factory is wired", () => {
    expect(new AppProbe().command("tree")).toBe(false);
  });
});

describe("pane resize", () => {
  it("grows and shrinks the focused pane from the leader chord", () => {
    const probe = new AppProbe();
    probe.command("split");
    const before = probe.rect("session-2").width;
    probe.keys("ctrl+k", "shift+.");
    expect(probe.rect("session-2").width).toBeGreaterThan(before);
    probe.keys("shift+,");
    expect(probe.rect("session-2").width).toBe(before);
  });

  it("resizes via the palette commands", () => {
    const probe = new AppProbe();
    probe.command("split");
    const before = probe.rect("session-2").width;
    expect(probe.command("grow")).toBe(true);
    expect(probe.rect("session-2").width).toBeGreaterThan(before);
    expect(probe.command("shrink")).toBe(true);
    expect(probe.rect("session-2").width).toBe(before);
  });
});

describe("mouse", () => {
  const modelFilePane = () => {
    const models = new Map<string, FileModel>();
    const probe = new AppProbe({
      createFilePane: (id, path) => {
        const model = new FileModel(process.cwd(), path, () => {});
        models.set(id, model);
        return stubFilePane(id, path, (chord) => model.handleKey(chord, 10));
      },
    });
    return { probe, models };
  };

  it("focuses the pane under a click", () => {
    const probe = new AppProbe();
    probe.command("split");
    const rect = probe.rect("session-1");
    probe.click(rect.x + 1, rect.y + 1);
    expect(probe.snapshot().focused).toBe("session-1");
  });

  it("wheel-scrolls the pane under the cursor without moving focus", () => {
    const { probe, models } = modelFilePane();
    probe.type("/open notes.txt").keys("enter");
    const session = probe.rect("session-1");
    probe.click(session.x + 1, session.y + 1);
    const file = probe.rect("file-1");
    probe.scroll(file.x + 1, file.y + 1, "down", 3);
    expect(models.get("file-1")?.scrollTop).toBe(3);
    expect(probe.snapshot().focused).toBe("session-1");
    probe.scroll(file.x + 1, file.y + 1, "up", 5);
    expect(models.get("file-1")?.scrollTop).toBe(0);
  });

  it("clamps huge wheel deltas to a bounded scroll", () => {
    const { probe, models } = modelFilePane();
    probe.type("/open notes.txt").keys("enter");
    const file = probe.rect("file-1");
    probe.scroll(file.x + 1, file.y + 1, "down", 10_000);
    expect(models.get("file-1")?.scrollTop).toBe(10);
  });

  it("moves the palette selection on hover, and arrows still win afterwards", () => {
    const probe = new AppProbe().keys("ctrl+p");
    const rows = Math.min(paletteRowLimit, probe.core.registry.search("").length);
    const frame = paletteFrame(probe.screen, rows);
    probe.hover(frame.x + 2, frame.firstRowY + 2);
    expect(probe.core.paletteIndex).toBe(2);
    probe.keys("down");
    expect(probe.core.paletteIndex).toBe(3);
  });

  it("runs the clicked palette row", () => {
    const probe = new AppProbe().keys("ctrl+p").type("split");
    const rows = Math.min(paletteRowLimit, probe.core.registry.search("split").length);
    const frame = paletteFrame(probe.screen, rows);
    probe.click(frame.x + 2, frame.firstRowY);
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(paneIds(probe)).toEqual(["session-1", "session-2"]);
  });

  it("closes the palette on an outside click without running anything", () => {
    const probe = new AppProbe().keys("ctrl+p").type("split");
    probe.click(0, 0);
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(paneIds(probe)).toEqual(["session-1"]);
  });

  it("closes the help overlay on an outside click", () => {
    const probe = new AppProbe().keys("ctrl+k", "/");
    expect(probe.snapshot().overlay).toBe("help");
    probe.click(0, 0);
    expect(probe.snapshot().overlay).toBeUndefined();
  });

  it("ignores clicks and scrolls when no pane is under the cursor", () => {
    const probe = new AppProbe();
    probe.click(500, 500).scroll(500, 500, "down").hover(500, 500);
    expect(paneIds(probe)).toEqual(["session-1"]);
    expect(probe.exited).toBe(false);
  });
});

describe("conversation round-trip", () => {
  it("sends a prompt and streams the scripted reply into the pane", async () => {
    const probe = new AppProbe({
      script: [textTurn("hey there", { inputTokens: 3, outputTokens: 5 })],
    });
    probe.type("hi").keys("enter");
    await probe.settled();

    expect(probe.model()?.entries).toEqual([
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "hey there" },
    ]);
    expect(probe.snapshot().panes[0]?.title).toBe("session-1 · 3▸5");
  });
});

describe("safety net", () => {
  it("announces undo and redo outcomes in the status notice", async () => {
    const probe = new AppProbe({
      undo: { undo: async () => true, redo: async () => false },
    });

    expect(probe.command("undo")).toBe(true);
    await waitFor(() => expect(probe.snapshot().notice).toBe("files restored"));

    expect(probe.command("redo")).toBe(true);
    await waitFor(() => expect(probe.snapshot().notice).toBe("nothing to redo"));

    probe.keys("a");
    expect(probe.snapshot().notice).toBe("");
  });

  it("hides undo commands when no checkpoint store is wired", () => {
    const probe = new AppProbe();
    expect(probe.command("undo")).toBe(false);
  });

  it("pauses a mutating tool on the ask and runs it after y", async () => {
    const executed: string[] = [];
    const scribble: Tool = {
      name: "scribble",
      description: "writes",
      parameters: { type: "object" },
      mutates: true,
      execute: async () => {
        executed.push("scribble");
        return "wrote";
      },
    };
    const probe = new AppProbe({
      createPane: (id, notify, commands) => {
        let pane: ConversationPane | undefined;
        const agent = new Agent({
          provider: new MockProvider([
            toolCallTurn({ type: "tool-call", callId: "c1", name: "scribble", arguments: {} }),
            textTurn("done"),
          ]),
          tools: [scribble],
          guard: { confirm: (call) => pane?.confirmMutation(call) ?? Promise.resolve(true) },
        });
        pane = new ConversationPane(id, agent, notify, undefined, commands);
        return pane;
      },
    });

    probe.type("go").keys("enter");
    await waitFor(() => expect(probe.model()?.pendingAsk).toBeDefined());
    expect(executed).toEqual([]);

    probe.keys("y");
    await probe.settled();

    expect(executed).toEqual(["scribble"]);
    expect(probe.model()?.entries.at(-1)).toEqual({ kind: "assistant", text: "done" });
  });

  it("feeds a decline back to the agent as an errored tool result", async () => {
    const probe = new AppProbe({
      createPane: (id, notify, commands) => {
        let pane: ConversationPane | undefined;
        const agent = new Agent({
          provider: new MockProvider([
            toolCallTurn({ type: "tool-call", callId: "c1", name: "scribble", arguments: {} }),
            textTurn("understood"),
          ]),
          tools: [
            {
              name: "scribble",
              description: "writes",
              parameters: { type: "object" },
              mutates: true,
              execute: async () => "wrote",
            },
          ],
          guard: { confirm: (call) => pane?.confirmMutation(call) ?? Promise.resolve(true) },
        });
        pane = new ConversationPane(id, agent, notify, undefined, commands);
        return pane;
      },
    });

    probe.type("go").keys("enter");
    await waitFor(() => expect(probe.model()?.pendingAsk).toBeDefined());
    probe.keys("n");
    await probe.settled();

    expect(probe.model()?.entries).toContainEqual({
      kind: "tool",
      text: "✗ scribble — declined by user",
      failed: true,
    });
  });
});

describe("conversation pane completion", () => {
  it("scrolls the transcript with the wheel and snaps back on escape", async () => {
    const probe = new AppProbe({
      script: [textTurn(Array.from({ length: 30 }, (_, at) => `line ${at + 1}`).join("\n"))],
    });
    probe.type("go").keys("enter");
    await probe.settled();

    const rect = probe.rect("session-1");
    probe.scroll(rect.x + 2, rect.y + 2, "up", 3);
    expect(probe.model()?.scrollBack).toBe(3);

    probe.keys("escape");
    expect(probe.model()?.scrollBack).toBe(0);
  });

  it("composes a multiline prompt and queues a follow-up while busy", async () => {
    const probe = new AppProbe({ script: [textTurn("first reply"), textTurn("second reply")] });
    probe.type("hello").keys("shift+return").type("world").keys("enter");
    probe.type("follow-up").keys("enter");
    await probe.settled();

    expect(probe.model()?.entries).toEqual([
      { kind: "user", text: "hello\nworld" },
      { kind: "assistant", text: "first reply" },
      { kind: "user", text: "follow-up" },
      { kind: "assistant", text: "second reply" },
    ]);
  });
});

describe("workspace persistence", () => {
  const describableFactories = () => ({
    createFilePane: (id: string, path: string): Pane => ({
      ...stubFilePane(id, path),
      describe: () => ({ kind: "file", path }),
    }),
    createBrowserPane: (id: string, root: string): Pane => ({
      ...stubFilePane(id, root),
      describe: () => ({ kind: "browser", root }),
    }),
  });

  const savedState = (probe: AppProbe): unknown =>
    JSON.parse(JSON.stringify(probe.workspaceState()));

  function buildWorkspace(): AppProbe {
    const probe = new AppProbe(describableFactories());
    probe.command("split");
    probe.keys("ctrl+k", "shift+.", "shift+.", "escape");
    probe.command("browse");
    probe.command("open notes.md");
    (probe.core.panes.get("session-1") as ConversationPane).sessionId = "sess-a";
    (probe.core.panes.get("session-2") as ConversationPane).sessionId = "sess-b";
    probe.core.layout.focus("session-2");
    return probe;
  }

  it("restores geometry, panes, dock, and focus into a fresh core", () => {
    const first = buildWorkspace();
    const state = mustParse(savedState(first));

    const resumed: string[] = [];
    const second = new AppProbe({
      ...describableFactories(),
      createPane: (id, notify, commands, resumeSessionId) => {
        if (resumeSessionId !== undefined) resumed.push(`${id}=${resumeSessionId}`);
        const pane = new ConversationPane(id, undefined, notify, undefined, commands);
        pane.sessionId = resumeSessionId;
        return pane;
      },
      restoreWorkspace: state,
    });

    expect(paneIds(second).sort()).toEqual(paneIds(first).sort());
    expect(second.snapshot().focused).toBe("session-2");
    expect(second.snapshot().dockSide).toBe(first.snapshot().dockSide);
    expect(dockedIds(second)).toEqual(dockedIds(first));
    for (const id of paneIds(first)) expect(second.rect(id)).toEqual(first.rect(id));
    expect(resumed.sort()).toEqual(["session-1=sess-a", "session-2=sess-b"]);

    second.command("split");
    expect(paneIds(second)).toContain("session-3");
  });

  it("persists browser panes as root only — expansion state absent by design", () => {
    const probe = new AppProbe(describableFactories());
    probe.command("browse src");
    const browser = probe.workspaceState().panes.find((pane) => pane.kind === "browser");
    expect(browser).toEqual({ id: "browser-1", kind: "browser", root: "src" });
  });

  it("skips panes whose revival fails and keeps the rest", () => {
    const state = mustParse(savedState(buildWorkspace()));
    const second = new AppProbe({
      ...describableFactories(),
      createFilePane: () => {
        throw new Error("file vanished");
      },
      restoreWorkspace: state,
    });
    expect(paneIds(second)).not.toContain("file-1");
    expect(paneIds(second)).toEqual(
      expect.arrayContaining(["session-1", "session-2", "browser-1"]),
    );
  });

  it("starts clean when nothing survives restore", () => {
    const first = new AppProbe(describableFactories());
    first.command("open notes.md");
    first.core.layout.focus("session-1");
    first.command("exit");
    const state = mustParse(savedState(first));
    expect(state.panes).toEqual([{ id: "file-1", kind: "file", path: "notes.md" }]);

    const second = new AppProbe({ restoreWorkspace: state });
    expect(paneIds(second)).toEqual(["session-1"]);
  });

  it("saves on layout changes but not on mere typing", () => {
    const saves: string[] = [];
    const probe = new AppProbe({
      saveWorkspace: (state) => saves.push(JSON.stringify(state)),
    });
    expect(saves).toHaveLength(1);
    probe.command("split");
    expect(saves).toHaveLength(2);
    probe.type("hello");
    expect(saves).toHaveLength(2);
    probe.keys("ctrl+k", "h");
    expect(saves).toHaveLength(3);
    expect(new Set(saves).size).toBe(3);
  });

  it("corrupt saved payloads are rejected before they reach the core", () => {
    expect(parseWorkspaceState("{ not json at all")).toBeUndefined();
    expect(parseWorkspaceState({ version: 99, layout: {}, panes: [] })).toBeUndefined();
  });
});
