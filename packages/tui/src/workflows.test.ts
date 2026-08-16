import {
  Agent,
  type Message,
  MockProvider,
  messageText,
  type SessionTreeNode,
  type Tool,
  type TurnDelta,
  textMessage,
  textTurn,
  toolCallTurn,
} from "@keywork/engine";
import { describe, expect, it } from "vitest";
import {
  bindSessionLifecycle,
  type CheckpointsPort,
  forkAtPrompt,
  paneSessionIndex,
  type SessionAttachment,
  type SessionTurn,
} from "./app.ts";
import { type PresetsPort, paletteFrame, paletteRowLimit } from "./app-core.ts";
import { BrowserPane } from "./browser-pane.ts";
import { ConversationPane } from "./conversation-pane.ts";
import { FileModel } from "./file-model.ts";
import type { Chord } from "./keys.ts";
import { McpPane, type McpPanePort } from "./mcp-pane.ts";
import type { McpServerView } from "./mcp-pane-model.ts";
import { MemoryPane, type MemoryPanePort } from "./memory-pane.ts";
import type { InboxItemView, MemoryPaneInputs } from "./memory-pane-model.ts";
import type { Pane } from "./pane.ts";
import { AppProbe } from "./probe.ts";
import type { SessionTreeModel } from "./session-tree-model.ts";
import { SessionTreePane, type SessionTreePort } from "./session-tree-pane.ts";
import type { SessionOverviewItem } from "./sessions-overview-model.ts";
import { resolveTheme } from "./theme.ts";
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
    .panes.filter((pane) => pane.dock !== undefined)
    .map((pane) => pane.id);
}

function dockOf(probe: AppProbe, id: string): "left" | "right" | undefined {
  return probe.snapshot().panes.find((pane) => pane.id === id)?.dock;
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
  it("docks, stacks a second pane, undocks, and re-docks right via commands", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.command("split");

    probe.command("dock-left");
    expect(dockOf(probe, "session-3")).toBe("left");
    expect(dockedIds(probe)).toEqual(["session-3"]);

    probe.keys("ctrl+k", "l", "escape");
    probe.command("dock-left");
    expect(dockedIds(probe)).toEqual(["session-3", "session-1"]);

    probe.command("undock");
    expect(dockedIds(probe)).toEqual(["session-3"]);
    expect(paneIds(probe)).toContain("session-1");

    probe.command("dock-right");
    expect(dockOf(probe, "session-1")).toBe("right");
    expect(dockOf(probe, "session-3")).toBe("left");
  });

  it("/dock-left on an already-left-docked pane is a no-op", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.command("dock-left");
    expect(dockOf(probe, "session-2")).toBe("left");
    const before = probe.workspaceState();
    probe.command("dock-left");
    expect(probe.workspaceState()).toEqual(before);
    expect(probe.snapshot().notice).toBe("");
  });

  it("/dock-right moves one left-docked pane to the right dock, leaving the rest", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.command("split");
    probe.command("dock-left");
    probe.keys("ctrl+k", "l", "escape");
    probe.command("dock-left");
    expect(dockedIds(probe)).toEqual(["session-3", "session-1"]);

    probe.command("dock-right");
    expect(dockOf(probe, "session-1")).toBe("right");
    expect(dockOf(probe, "session-3")).toBe("left");
    expect(dockedIds(probe)).toEqual(["session-3", "session-1"]);
  });

  it("dragging the dock boundary resizes the dock without stealing focus", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.command("dock-left");
    expect(probe.rect("session-2").width).toBe(40);
    probe.keys("ctrl+k", "l", "escape");
    expect(probe.snapshot().focused).toBe("session-1");

    probe.drag({ x: 40, y: 10 }, { x: 19, y: 10 });
    expect(probe.rect("session-2").width).toBe(20);
    expect(probe.snapshot().focused).toBe("session-1");

    probe.drag({ x: 19, y: 10 }, { x: 59, y: 10 });
    expect(probe.rect("session-2").width).toBe(60);
  });

  it("leaves an idle main area rather than letting docks take the screen", () => {
    const probe = new AppProbe();
    probe.command("dock-left");
    expect(dockOf(probe, "session-1")).toBe("left");
    expect(probe.rect("session-1").width).toBeLessThan(probe.screen.width / 2);
    expect(probe.core.layout.emptyMainRect(probe.screen)).toBeDefined();
  });

  it("cycles the focused pane main → left → right → main with leader c", () => {
    const probe = new AppProbe();
    probe.command("split");

    probe.keys("ctrl+k", "c");
    expect(dockOf(probe, "session-2")).toBe("left");
    probe.keys("c");
    expect(dockOf(probe, "session-2")).toBe("right");
    probe.keys("c");
    expect(dockOf(probe, "session-2")).toBeUndefined();
    expect(probe.snapshot().focused).toBe("session-2");
    expect(dockedIds(probe)).toEqual([]);
  });

  it("/dock-cycle is the command spelling of the cycle verb", () => {
    const probe = new AppProbe();
    probe.command("split");
    expect(probe.command("dock-cycle")).toBe(true);
    expect(dockOf(probe, "session-2")).toBe("left");
  });

  it("dock resize keys act on the focused pane's dock; side commands reach the other", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.command("split");
    probe.command("dock-left");
    probe.keys("ctrl+k", "l", "escape");
    probe.command("dock-right");
    expect(dockOf(probe, "session-3")).toBe("left");
    expect(dockOf(probe, "session-1")).toBe("right");

    const width = (id: string) => probe.rect(id).width;
    const leftBefore = width("session-3");
    const rightBefore = width("session-1");
    probe.keys("ctrl+k", ".", "escape");
    expect(width("session-1")).toBeGreaterThan(rightBefore);
    expect(width("session-3")).toBe(leftBefore);

    probe.command("dock-left-wider");
    expect(width("session-3")).toBeGreaterThan(leftBefore);
    probe.command("dock-left-narrower");
    expect(width("session-3")).toBe(leftBefore);
  });
});

describe("moving panes", () => {
  it("shift+l swaps with the main neighbor and keeps focus on the moved pane", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.keys("ctrl+k", "h", "shift+l");
    expect(probe.snapshot().focused).toBe("session-1");
    expect(probe.rect("session-1").x).toBeGreaterThan(probe.rect("session-2").x);
  });

  it("shift+h pushes the edge main pane into the left dock", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.command("dock-left");
    probe.keys("ctrl+k", "l", "escape");
    probe.keys("ctrl+k", "shift+h");
    expect(dockedIds(probe)).toEqual(["session-2", "session-1"]);
  });

  it("shift+j and shift+k reorder a docked stack", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.command("split");
    probe.command("dock-left");
    probe.keys("ctrl+k", "l", "escape");
    probe.command("dock-left");
    expect(dockedIds(probe)).toEqual(["session-3", "session-1"]);
    probe.keys("ctrl+k", "shift+k");
    expect(dockedIds(probe)).toEqual(["session-1", "session-3"]);
    probe.keys("shift+j");
    expect(dockedIds(probe)).toEqual(["session-3", "session-1"]);
  });

  it("shift+l brings a left-docked pane back into the main area", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.command("dock-left");
    probe.keys("ctrl+k", "shift+l");
    expect(dockedIds(probe)).toEqual([]);
    expect(probe.rect("session-2").x).toBeLessThan(probe.rect("session-1").x);
  });

  it("/push-right is the command spelling of the move verb", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.keys("ctrl+k", "h", "escape");
    expect(probe.command("push-right")).toBe(true);
    expect(probe.rect("session-1").x).toBeGreaterThan(probe.rect("session-2").x);
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

  it("reports the closed pane id through onPaneClosed", () => {
    const closedIds: string[] = [];
    const probe = new AppProbe({ onPaneClosed: (id) => closedIds.push(id) });
    probe.command("split");
    const before = paneIds(probe);
    probe.keys("ctrl+k", "x");
    expect(closedIds).toHaveLength(1);
    expect(before).toContain(closedIds[0]);
    expect(paneIds(probe)).not.toContain(closedIds[0]);
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
    probe.command("dock-left");
    expect(dockedIds(probe)).toEqual(["session-2"]);

    probe.keys("ctrl+k", "s");
    expect(dockedIds(probe)).toEqual(["session-2"]);
    expect(paneIds(probe)).toEqual(["session-2", "session-1", "session-3"]);
    expect(probe.snapshot().focused).toBe("session-3");
  });

  it("lands in the main area even when every pane is docked", () => {
    const probe = new AppProbe();
    probe.command("dock-left");
    expect(dockedIds(probe)).toEqual(["session-1"]);

    probe.keys("ctrl+k", "s");
    expect(dockedIds(probe)).toEqual(["session-1"]);
    expect(paneIds(probe)).toEqual(["session-1", "session-2"]);
    expect(dockOf(probe, "session-1")).toBe("left");
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
    expect(paneIds(probe)).toEqual(["browser-1", "session-1"]);
    expect(dockedIds(probe)).toEqual(["browser-1"]);
    expect(dockOf(probe, "browser-1")).toBe("left");
    expect(probe.snapshot().focused).toBe("browser-1");
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

  it("browse is absent when no browser factory is wired", () => {
    expect(new AppProbe().command("browse")).toBe(false);
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
    return { id, title, modifiedAt, entryCount: 5, branchCount: 1, labelCount: 1 };
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

  function treeModel(probe: AppProbe, id = "tree-1"): SessionTreeModel {
    return treePane(probe, id).model;
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
    expect(pane.overview.rows().map((row) => [row.id, row.liveness])).toEqual([
      ["sess-session-1", "attached"],
      ["idle-1", "idle"],
    ]);
    expect(pane.overview.cursorRow()?.id).toBe("sess-session-1");
    expect(probe.snapshot().panes.find((pane2) => pane2.id === "tree-1")?.title).toContain(
      "2 sessions",
    );
  });

  it("/sessions is a first-class alias for the same pane", async () => {
    const { probe } = treeProbe();
    expect(probe.command("sessions")).toBe(true);
    expect(paneIds(probe)).toEqual(["tree-1", "session-1"]);
    expect(probe.snapshot().focused).toBe("tree-1");
  });

  it("zero sessions renders a calm overview", async () => {
    const { probe, world } = treeProbe();
    world.sessions = [];
    probe.command("tree");
    probe.keys("r");
    await probe.settled();
    expect(treePane(probe).overview.rows()).toEqual([]);
    expect(probe.snapshot().panes.find((pane) => pane.id === "tree-1")?.title).toBe("session tree");
  });

  it("leader t summons the tree and refocuses it instead of duplicating", () => {
    const { probe } = treeProbe();
    probe.keys("ctrl+k", "t");
    expect(paneIds(probe)).toEqual(["tree-1", "session-1"]);
    expect(probe.snapshot().focused).toBe("tree-1");
    probe.keys("ctrl+k", "l");
    expect(probe.snapshot().focused).toBe("session-1");
    probe.keys("t");
    expect(probe.snapshot().focused).toBe("tree-1");
    expect(paneIds(probe)).toEqual(["tree-1", "session-1"]);
  });

  it("l drills into the cursored session and esc returns with the overview cursor kept", async () => {
    const { probe } = treeProbe();
    probe.command("tree");
    await probe.settled();
    const pane = treePane(probe);
    probe.keys("j", "l");
    await probe.settled();
    expect(pane.level()).toBe("entries");
    expect(pane.model.sessionId()).toBe("idle-1");
    probe.keys("escape");
    await probe.settled();
    expect(pane.level()).toBe("overview");
    expect(pane.overview.cursorRow()?.id).toBe("idle-1");
  });

  it("enter over a session with an open pane focuses that pane instead of duplicating", async () => {
    const { probe, world } = treeProbe();
    probe.command("tree");
    await probe.settled();
    probe.keys("enter");
    await probe.settled();
    expect(probe.snapshot().focused).toBe("session-1");
    expect(paneIds(probe)).toEqual(["tree-1", "session-1"]);
    expect(world.attached).toEqual([]);
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

  it("a pushed session change re-lists the overview with no manual refresh", async () => {
    const { probe, world, emit } = treeProbe();
    probe.command("tree");
    await probe.settled();
    world.sessions = [overviewItemOf("fresh-1", 9, "fresh"), ...world.sessions];
    emit("fresh-1");
    emit("fresh-1");
    await waitFor(() => {
      expect(
        treePane(probe)
          .overview.rows()
          .map((row) => row.id),
      ).toEqual(["fresh-1", "sess-session-1", "idle-1"]);
    });
  });

  it("a fork lands in the overview unprompted when the pane returns to it", async () => {
    const { probe } = await drilledProbe();
    probe.keys("j", "f");
    await probe.settled();
    expect(probe.snapshot().focused).toBe("session-2");
    probe.command("tree");
    probe.keys("escape");
    await waitFor(() => {
      expect(
        treePane(probe)
          .overview.rows()
          .map((row) => row.id),
      ).toEqual(["forked-1", "sess-session-1", "idle-1"]);
    });
  });

  it("renders branch structure and navigates with j/k", async () => {
    const { probe } = await drilledProbe();
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
    const { probe, world } = await drilledProbe();
    probe.keys("j", "j", "f");
    await probe.settled();
    expect(world.forkedFrom).toEqual(["u2"]);
    expect(world.resumed).toEqual([undefined, "forked-1"]);
    expect(paneIds(probe)).toEqual(["tree-1", "session-1", "session-2"]);
    expect(dockedIds(probe)).toEqual(["tree-1"]);
    expect(probe.snapshot().focused).toBe("session-2");
  });

  it("labels round-trip: shift+l edits, enter commits, the reloaded tree shows it", async () => {
    const { probe, world } = await drilledProbe();
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
    const { probe, world } = await drilledProbe();
    probe.keys("j", "j");
    world.entries.push({ id: "u0", parentId: null, text: "second root" });
    probe.keys("r");
    await probe.settled();
    const model = treeModel(probe);
    expect(model.rows()).toHaveLength(6);
    expect(model.cursorRow()?.id).toBe("u2");
  });

  it("a refresh that deletes the cursored node clamps to the nearest row", async () => {
    const { probe, world } = await drilledProbe();
    probe.keys("j", "j", "j", "j");
    expect(treeModel(probe).cursorRow()?.id).toBe("a2b");
    world.entries = world.entries.filter((entry) => entry.id !== "a2b");
    probe.keys("r");
    await probe.settled();
    const model = treeModel(probe);
    expect(model.rows()).toHaveLength(4);
    expect(model.cursorRow()).toBeDefined();
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
    expect(pane.overview.rows().map((row) => row.id)).toEqual(["sess-session-1"]);
    expect(pane.describe()).toEqual({ kind: "session-tree", sessionId: "sess-session-1" });
  });

  it("tree is absent when no session-tree factory is wired", () => {
    expect(new AppProbe().command("tree")).toBe(false);
  });
});

describe("split refusal", () => {
  it("refuses a split below minimum pane size with a status notice", () => {
    const probe = new AppProbe({ screen: { width: 9, height: 5 } });
    probe.keys("ctrl+k", "s");
    expect(paneIds(probe)).toEqual(["session-1"]);
    expect(probe.snapshot().notice).toContain("no room");
  });

  it("keeps splitting normally on a screen with room", () => {
    const probe = new AppProbe();
    probe.keys("ctrl+k", "s");
    expect(paneIds(probe)).toEqual(["session-1", "session-2"]);
    expect(probe.snapshot().notice).toBe("");
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

  it("click hit-testing agrees with the drawn rects after a resize", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.command("grow");
    const shrunk = probe.rect("session-1");
    probe.click(shrunk.x + shrunk.width - 1, shrunk.y + 1);
    expect(probe.snapshot().focused).toBe("session-1");
    const grown = probe.rect("session-2");
    probe.click(grown.x, grown.y + 1);
    expect(probe.snapshot().focused).toBe("session-2");
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
    await waitFor(() => expect(probe.snapshot().notice).toBe("files put back"));

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

describe("live tool tail-follow", () => {
  function tailProbe(finishTool: Promise<void>) {
    const agents: Agent[] = [];
    const streaming: Tool = {
      name: "slow",
      description: "streams output",
      parameters: { type: "object" },
      execute: async () => {
        const agent = agents[0];
        agent?.bus.emit("tool.output", { chunk: "step 1\n\x1b[31mstep 2\x1b[0m\n" });
        agent?.bus.emit("tool.output", { chunk: `step 3 ${"x".repeat(500)}\n` });
        await finishTool;
        return "final result";
      },
    };
    const probe = new AppProbe({
      createPane: (id, notify, commands) => {
        const agent = new Agent({
          provider: new MockProvider([
            toolCallTurn({ type: "tool-call", callId: "t1", name: "slow", arguments: {} }),
            textTurn("done"),
          ]),
          tools: [streaming],
        });
        agents.push(agent);
        return new ConversationPane(id, agent, notify, undefined, commands);
      },
    });
    return { probe, agents };
  }

  it("grows a bounded dim tail while the tool runs and settles to the ✓ line", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { probe, agents } = tailProbe(gate);
    probe.type("go").keys("enter");
    await waitFor(() => {
      const tail = probe
        .model()
        ?.visibleTranscript(38, 12)
        .filter((line) => line.kind === "tail");
      expect(tail?.length).toBeGreaterThan(0);
    });

    const tail = (probe.model()?.visibleTranscript(38, 12) ?? []).filter(
      (line) => line.kind === "tail",
    );
    expect(tail.length).toBeLessThanOrEqual(3);
    for (const line of tail) expect(line.text).toMatch(/^[░▒▓█] /);
    expect(tail.map((line) => line.text)).toContainEqual(expect.stringContaining("step 2"));
    expect(tail.some((line) => line.text.includes("\x1b"))).toBe(false);
    expect(tail.some((line) => line.text.includes("…"))).toBe(true);
    for (const line of tail) expect(Array.from(line.text).length).toBeLessThanOrEqual(38);

    release();
    await probe.settled();

    const lines = probe.model()?.visibleTranscript(38, 12) ?? [];
    expect(lines.filter((line) => line.kind === "tail")).toEqual([]);
    expect(probe.model()?.entries).toContainEqual({
      kind: "tool",
      text: "✓ slow — final result",
      failed: false,
    });

    const toolResults = (agents[0]?.history() ?? [])
      .filter((message) => message.role === "tool")
      .flatMap((message) => message.parts);
    expect(toolResults).toEqual([
      { type: "tool-result", callId: "t1", output: "final result", isError: false },
    ]);
  });
});

describe("diff preview in the ask", () => {
  function writeAskProbe(
    files: Record<string, string>,
    executed: string[],
    call: { name: string; arguments: unknown },
  ) {
    return new AppProbe({
      createPane: (id, notify, commands) => {
        let pane: ConversationPane | undefined;
        const agent = new Agent({
          provider: new MockProvider([
            toolCallTurn({
              type: "tool-call",
              callId: "m1",
              name: call.name,
              arguments: call.arguments,
            }),
            textTurn("done"),
          ]),
          tools: [
            {
              name: call.name,
              description: "mutates",
              parameters: { type: "object" },
              mutates: true,
              execute: async () => {
                executed.push(call.name);
                return "ok";
              },
            },
          ],
          guard: {
            confirm: (askedCall) => pane?.confirmMutation(askedCall) ?? Promise.resolve(true),
          },
        });
        pane = new ConversationPane(id, agent, notify, undefined, commands, {
          ports: { readFile: (path) => files[path] },
        });
        return pane;
      },
    });
  }

  it("renders the pending write as a unified diff and only runs it after y", async () => {
    const executed: string[] = [];
    const probe = writeAskProbe({ "notes.txt": "alpha\nbeta\ngamma\n" }, executed, {
      name: "write",
      arguments: { path: "notes.txt", content: "alpha\nBETA\ngamma\n" },
    });
    probe.type("go").keys("enter");
    await waitFor(() => expect(probe.model()?.pendingAsk?.diff).toBeDefined());
    expect(executed).toEqual([]);

    const window = probe.model()?.askDiffWindow(10);
    expect(window?.lines).toContainEqual({ kind: "del", text: "beta" });
    expect(window?.lines).toContainEqual({ kind: "add", text: "BETA" });

    probe.keys("down");
    expect(probe.model()?.pendingAsk).toBeDefined();

    probe.keys("y");
    await probe.settled();
    expect(executed).toEqual(["write"]);
  });

  it("scrolls a long diff inside a bounded window without answering the ask", async () => {
    const before = Array.from({ length: 40 }, (_, at) => `old ${at}`).join("\n");
    const after = Array.from({ length: 40 }, (_, at) => `new ${at}`).join("\n");
    const probe = writeAskProbe({ "big.txt": before }, [], {
      name: "write",
      arguments: { path: "big.txt", content: after },
    });
    probe.type("go").keys("enter");
    await waitFor(() => expect(probe.model()?.pendingAsk?.diff).toBeDefined());

    const top = probe.model()?.askDiffWindow(5);
    expect(top?.above).toBe(0);
    expect(top?.below).toBeGreaterThan(0);

    probe.keys("down", "down");
    expect(probe.model()?.askDiffWindow(5).above).toBe(2);
    probe.keys("up", "up", "up");
    expect(probe.model()?.askDiffWindow(5).above).toBe(0);
    expect(probe.model()?.pendingAsk).toBeDefined();

    probe.keys("n");
    await probe.settled();
  });

  it("keeps the plain ask for non-write tools", async () => {
    const executed: string[] = [];
    const probe = writeAskProbe({}, executed, {
      name: "bash",
      arguments: { command: "echo hi" },
    });
    probe.type("go").keys("enter");
    await waitFor(() => expect(probe.model()?.pendingAsk).toBeDefined());
    expect(probe.model()?.pendingAsk?.diff).toBeUndefined();
    probe.keys("y");
    await probe.settled();
    expect(executed).toEqual(["bash"]);
  });
});

describe("esc-backtrack prompt stepping", () => {
  function backtrackProbe(
    forks: { ordinal: number; draft: string }[],
    outcome: boolean | (() => Promise<boolean>) = true,
  ) {
    return new AppProbe({
      createPane: (id, notify, commands) => {
        const agent = new Agent({
          provider: new MockProvider([textTurn("re: one"), textTurn("re: two")]),
        });
        return new ConversationPane(id, agent, notify, undefined, commands, {
          ports: {
            forkAtPrompt: async (ordinal, draft) => {
              forks.push({ ordinal, draft });
              const forked = typeof outcome === "boolean" ? outcome : await outcome();
              return { forked };
            },
          },
        });
      },
    });
  }

  async function conversed(probe: AppProbe, ...prompts: string[]): Promise<AppProbe> {
    for (const prompt of prompts) {
      probe.type(prompt).keys("enter");
      await probe.settled();
    }
    return probe;
  }

  it("does nothing on esc-esc when no prompts exist", () => {
    const probe = new AppProbe();
    probe.keys("escape", "escape");
    expect(probe.model()?.backtracking()).toBe(false);
    expect(probe.model()?.entries.filter((entry) => entry.kind === "user")).toEqual([]);
  });

  it("walks prior prompts with a visible highlight and cancels on escape", async () => {
    const probe = await conversed(backtrackProbe([]), "one", "two");
    probe.keys("escape", "escape");
    expect(probe.model()?.backtracking()).toBe(true);

    const selectedText = () =>
      (probe.model()?.visibleTranscript(60, 12) ?? [])
        .filter((line) => line.selected === true)
        .map((line) => line.text);
    expect(selectedText()).toEqual(["› two"]);

    probe.keys("up");
    expect(selectedText()).toEqual(["› one"]);
    probe.keys("up");
    expect(selectedText()).toEqual(["› one"]);
    probe.keys("down");
    expect(selectedText()).toEqual(["› two"]);

    probe.keys("escape");
    expect(probe.model()?.backtracking()).toBe(false);
    expect(selectedText()).toEqual([]);
  });

  it("stepping past the newest prompt leaves backtrack quietly", async () => {
    const probe = await conversed(backtrackProbe([]), "one", "two");
    probe.keys("escape", "escape", "down");
    expect(probe.model()?.backtracking()).toBe(false);
  });

  it("enter forks at the selected prompt, including the very first one", async () => {
    const forks: { ordinal: number; draft: string }[] = [];
    const probe = await conversed(backtrackProbe(forks), "one", "two");
    probe.keys("escape", "escape", "up", "enter");
    await probe.settled();

    expect(forks).toEqual([{ ordinal: 0, draft: "one" }]);
    expect(probe.model()?.backtracking()).toBe(false);
    expect(probe.model()?.entries.filter((entry) => entry.kind === "info")).toEqual([]);
  });

  it("reports truthfully when the fork cannot happen", async () => {
    const forks: { ordinal: number; draft: string }[] = [];
    const probe = await conversed(backtrackProbe(forks, false), "one");
    probe.keys("escape", "escape", "enter");
    await probe.settled();

    expect(forks).toEqual([{ ordinal: 0, draft: "one" }]);
    expect(probe.model()?.entries.at(-1)).toEqual({
      kind: "info",
      text: "no fork point there",
    });
  });

  it("says so when no fork port is wired instead of silently dropping", async () => {
    const probe = new AppProbe({ script: [textTurn("re: one")] });
    probe.type("one").keys("enter");
    await probe.settled();
    probe.keys("escape", "escape", "enter");
    await probe.settled();
    expect(probe.model()?.entries.at(-1)).toEqual({
      kind: "info",
      text: "can't fork · no session store",
    });
  });

  it("interrupts instead of backtracking while the agent is busy", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agents: Agent[] = [];
    const probe = new AppProbe({
      createPane: (id, notify, commands) => {
        const agent = new Agent({
          provider: new MockProvider([
            toolCallTurn({ type: "tool-call", callId: "b1", name: "block", arguments: {} }),
          ]),
          tools: [
            {
              name: "block",
              description: "waits",
              parameters: { type: "object" },
              execute: async () => {
                await gate;
                return "done";
              },
            },
          ],
        });
        agents.push(agent);
        return new ConversationPane(id, agent, notify, undefined, commands);
      },
    });
    probe.type("go").keys("enter");
    await waitFor(() => expect(agents[0]?.busy()).toBe(true));

    probe.keys("escape", "escape");
    expect(probe.model()?.backtracking()).toBe(false);

    release();
    await probe.settled();
    expect(probe.model()?.busy).toBe(false);
  });

  it("counts replayed prompts so fork ordinals match the session", async () => {
    const forks: { ordinal: number; draft: string }[] = [];
    const agents: Agent[] = [];
    const probe = new AppProbe({
      createPane: (id, notify, commands) => {
        const agent = new Agent({ provider: new MockProvider([textTurn("re: new")]) });
        agents.push(agent);
        return new ConversationPane(id, agent, notify, undefined, commands, {
          ports: {
            forkAtPrompt: async (ordinal, draft) => {
              forks.push({ ordinal, draft });
              return { forked: true };
            },
          },
        });
      },
    });
    agents[0]?.bus.emit("turn.started", { userText: "old prompt", replay: true });
    probe.type("new prompt").keys("enter");
    await probe.settled();

    probe.keys("escape", "escape", "up", "enter");
    await probe.settled();
    expect(forks).toEqual([{ ordinal: 0, draft: "old prompt" }]);
  });

  it("opens a forked pane with the chosen prompt preloaded for editing", () => {
    const probe = new AppProbe();
    probe.core.openPane(undefined, "edit me first");
    expect(probe.model()?.input).toBe("edit me first");
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
    expect(dockedIds(second)).toEqual(dockedIds(first));
    for (const id of dockedIds(first)) expect(dockOf(second, id)).toBe(dockOf(first, id));
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

describe("memory pane", () => {
  interface MemoryWorld {
    inbox: InboxItemView[];
    approved: string[];
    discarded: string[];
  }

  function memoryProbe(inputs?: Partial<MemoryPaneInputs>) {
    const world: MemoryWorld = {
      inbox: [
        {
          id: "staged-1",
          kind: "staged",
          title: "config change",
          provenance: "untrusted",
          created: "2026-08-10T01:00:00Z",
        },
      ],
      approved: [],
      discarded: [],
    };
    const port: MemoryPanePort = {
      load: async () => ({
        scopes: ["workspace"],
        notes: [
          {
            name: "ratio-rule",
            title: "ratio-rule",
            scope: "workspace",
            provenance: "agent" as const,
            curing: 3 as const,
            links: [],
            aliases: [],
          },
        ],
        inbox: world.inbox,
        recalls: [],
        ...inputs,
      }),
      approve: async (id) => {
        const found = world.inbox.find((item) => item.id === id);
        if (found === undefined) throw new Error(`no review item with id ${id}`);
        world.inbox = world.inbox.filter((item) => item.id !== id);
        world.approved.push(id);
      },
      discard: async (id) => {
        world.inbox = world.inbox.filter((item) => item.id !== id);
        world.discarded.push(id);
      },
    };
    const probe = new AppProbe({
      createMemoryPane: (id, notify) => new MemoryPane(id, notify, port),
    });
    return { probe, world, port };
  }

  function memoryPane(probe: AppProbe, id = "memory-1"): MemoryPane {
    const pane = probe.core.panes.get(id);
    if (!(pane instanceof MemoryPane)) throw new Error(`no memory pane "${id}"`);
    return pane;
  }

  it("/memory opens the pane docked and focused with counts in the title", async () => {
    const { probe } = memoryProbe();
    probe.type("/memory").keys("enter");
    expect(paneIds(probe)).toEqual(["memory-1", "session-1"]);
    expect(dockedIds(probe)).toEqual(["memory-1"]);
    expect(probe.snapshot().focused).toBe("memory-1");
    await probe.settled();
    expect(probe.snapshot().panes.find((pane) => pane.id === "memory-1")?.title).toContain(
      "1 note",
    );
  });

  it("leader m summons the memory pane and refocuses instead of duplicating", () => {
    const { probe } = memoryProbe();
    probe.keys("ctrl+k", "m");
    expect(paneIds(probe)).toEqual(["memory-1", "session-1"]);
    expect(probe.snapshot().focused).toBe("memory-1");
    probe.keys("ctrl+k", "l");
    expect(probe.snapshot().focused).toBe("session-1");
    probe.keys("m");
    expect(probe.snapshot().focused).toBe("memory-1");
    expect(paneIds(probe)).toEqual(["memory-1", "session-1"]);
  });

  it("i jumps to the inbox and a approves the staged item through the port", async () => {
    const { probe, world } = memoryProbe();
    probe.command("memory");
    await probe.settled();
    probe.keys("i", "a");
    await probe.settled();
    expect(world.approved).toEqual(["staged-1"]);
    expect(memoryPane(probe).model.stagedCount()).toBe(0);
  });

  it("approving an already-resolved item shows a calm failure and r recovers", async () => {
    const { probe, world } = memoryProbe();
    probe.command("memory");
    await probe.settled();
    const pane = memoryPane(probe);
    world.inbox = [];
    probe.keys("i", "a");
    await probe.settled();
    expect(world.approved).toEqual([]);
    const failed = JSON.stringify(describePaneTree(pane.view(paneContext())));
    expect(failed).toContain("no review item with id staged-1");
    probe.keys("r");
    await probe.settled();
    const recovered = JSON.stringify(describePaneTree(pane.view(paneContext())));
    expect(recovered).not.toContain("no review item");
  });

  it("persists as a memory pane and revives from workspace state", async () => {
    const { probe, port } = memoryProbe();
    probe.command("memory");
    await probe.settled();
    const state = mustParse(probe.workspaceState());
    expect(state.panes).toContainEqual({ id: "memory-1", kind: "memory" });
    const restored = new AppProbe({
      createMemoryPane: (id, notify) => new MemoryPane(id, notify, port),
      restoreWorkspace: state,
    });
    await restored.settled();
    expect(paneIds(restored)).toEqual(["memory-1", "session-1"]);
    expect(memoryPane(restored).model.noteCount()).toBe(1);
  });

  it("an empty vault renders the calm invitation, not a dashboard of zeros", async () => {
    const { probe } = memoryProbe({ scopes: [], notes: [], inbox: [], recalls: [] });
    probe.command("memory");
    await probe.settled();
    const rows = memoryPane(probe).model.rows();
    expect(rows.map((row) => row.text)).toEqual(["nothing remembered yet"]);
  });

  it("memory is absent when no memory factory is wired", () => {
    expect(new AppProbe().command("memory")).toBe(false);
  });
});

describe("session after-turn lifecycle", () => {
  interface RecordedAttachment extends SessionAttachment {
    appended: Message[];
  }

  function recordedAttachment(id: string): RecordedAttachment {
    const appended: Message[] = [];
    return {
      id,
      history: [],
      appended,
      replay: () => {},
      append: async (message) => {
        appended.push(message);
      },
    };
  }

  function lifecycleProbe(options: {
    turns: TurnDelta[][];
    afterTurn?: (turn: SessionTurn) => Promise<readonly Message[]>;
  }) {
    const attachment = recordedAttachment("sess-1");
    const rebuilt: Agent[] = [];
    const probe = new AppProbe({
      createPane: (id, notify, commands) => {
        const provider = new MockProvider(options.turns);
        const agent = new Agent({ provider });
        const pane = new ConversationPane(id, agent, notify, undefined, commands);
        bindSessionLifecycle({
          pane,
          agent,
          attachment,
          ...(options.afterTurn !== undefined && { afterTurn: options.afterTurn }),
          rebuild: (history) => {
            const next = new Agent({ provider, bus: agent.bus, history });
            rebuilt.push(next);
            return next;
          },
        });
        pane.sessionId = attachment.id;
        return pane;
      },
    });
    return { probe, attachment, rebuilt };
  }

  it("persists turn messages, then joins flush messages into store and agent context", async () => {
    const flushMessages = [
      textMessage("user", "FLUSH-PROMPT"),
      textMessage("assistant", "FLUSH-REPLY"),
    ];
    const seen: string[] = [];
    const { probe, attachment, rebuilt } = lifecycleProbe({
      turns: [textTurn("first reply"), textTurn("second reply")],
      afterTurn: async ({ sessionId, history }) => {
        seen.push(`${sessionId}:${history.length}`);
        if (seen.length > 1) return [];
        for (const message of flushMessages) await attachment.append(message);
        return flushMessages;
      },
    });
    probe.type("hi").keys("enter");
    await probe.settled();

    expect(seen).toEqual(["sess-1:2"]);
    expect(attachment.appended.map((message) => messageText(message))).toEqual([
      "hi",
      "first reply",
      "FLUSH-PROMPT",
      "FLUSH-REPLY",
    ]);
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]?.history()).toHaveLength(4);
    expect(probe.model()?.entries.some((entry) => entry.text.includes("FLUSH"))).toBe(false);

    probe.type("again").keys("enter");
    await probe.settled();
    expect(probe.model()?.entries.at(-1)).toEqual({ kind: "assistant", text: "second reply" });
    expect(attachment.appended.map((message) => messageText(message)).slice(4)).toEqual([
      "again",
      "second reply",
    ]);
    expect(rebuilt[0]?.history()).toHaveLength(6);
  });

  it("keeps the turn open until the after-turn hook settles", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { probe } = lifecycleProbe({
      turns: [textTurn("reply")],
      afterTurn: async () => {
        await gate;
        return [];
      },
    });
    probe.type("hi").keys("enter");
    await waitFor(() =>
      expect(probe.model()?.entries.at(-1)).toEqual({ kind: "assistant", text: "reply" }),
    );
    expect(probe.model()?.busy).toBe(true);
    release();
    await probe.settled();
    expect(probe.model()?.busy).toBe(false);
  });

  it("surfaces an after-turn failure and keeps the pane usable", async () => {
    const { probe } = lifecycleProbe({
      turns: [textTurn("first"), textTurn("second")],
      afterTurn: async () => {
        throw new Error("flush pipeline broke");
      },
    });
    probe.type("one").keys("enter");
    await probe.settled();
    expect(probe.model()?.entries).toContainEqual({ kind: "error", text: "flush pipeline broke" });
    expect(probe.model()?.busy).toBe(false);

    probe.type("two").keys("enter");
    await probe.settled();
    expect(probe.model()?.entries).toContainEqual({ kind: "assistant", text: "second" });
  });
});

describe("preset overlay", () => {
  function presetProbe(overrides?: Partial<PresetsPort>) {
    const applied: string[] = [];
    let active = "standard";
    const port: PresetsPort = {
      names: () => ["careful", "standard", "open"],
      active: () => active,
      requiresConfirmation: (name) => name === "open",
      apply: async (name) => {
        applied.push(name);
        active = name;
      },
      ...overrides,
    };
    const probe = new AppProbe({ presets: port });
    return { probe, applied, setActive: (name: string) => (active = name) };
  }

  it("/preset opens the picker with the active preset marked", () => {
    const { probe } = presetProbe();
    probe.type("/preset").keys("enter");
    expect(probe.snapshot().overlay).toBe("preset");
    expect(probe.core.presetPicker()).toEqual({
      names: ["careful", "standard", "open"],
      active: "standard",
      index: 1,
    });
  });

  it("choosing the active preset just closes with a notice", () => {
    const { probe, applied } = presetProbe();
    probe.command("preset");
    probe.keys("enter");
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(probe.snapshot().notice).toBe("already on standard");
    expect(applied).toEqual([]);
  });

  it("tightening applies without confirmation", async () => {
    const { probe, applied } = presetProbe();
    probe.command("preset");
    probe.keys("up", "enter");
    await waitFor(() => expect(probe.snapshot().notice).toBe("permissions preset → careful"));
    expect(applied).toEqual(["careful"]);
    expect(probe.snapshot().overlay).toBeUndefined();
  });

  it("loosening asks first; declining leaves the matrix untouched and closes", () => {
    const { probe, applied } = presetProbe();
    probe.command("preset");
    probe.keys("down", "enter");
    expect(probe.snapshot().overlay).toBe("preset-confirm");
    expect(probe.core.presetConfirmation()).toEqual({ from: "standard", to: "open" });
    probe.keys("n");
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(applied).toEqual([]);
  });

  it("loosening applies after an explicit y", async () => {
    const { probe, applied } = presetProbe();
    probe.command("preset");
    probe.keys("down", "enter", "y");
    await waitFor(() => expect(probe.snapshot().notice).toBe("permissions preset → open"));
    expect(applied).toEqual(["open"]);
  });

  it("derives the active preset live instead of caching it", () => {
    const { probe, setActive } = presetProbe();
    probe.command("preset");
    expect(probe.core.presetPicker()?.active).toBe("standard");
    setActive("open");
    expect(probe.core.presetPicker()?.active).toBe("open");
  });

  it("marks a custom matrix that matches no preset", () => {
    const { probe, setActive } = presetProbe();
    setActive("custom");
    probe.command("preset");
    const picker = probe.core.presetPicker();
    expect(picker?.active).toBe("custom");
    expect(picker?.names).not.toContain("custom");
    expect(picker?.index).toBe(0);
  });

  it("takes key precedence over a pending ask and hands keys back afterwards", async () => {
    const executed: string[] = [];
    const applied: string[] = [];
    const port: PresetsPort = {
      names: () => ["careful", "standard", "open"],
      active: () => "standard",
      requiresConfirmation: (name) => name === "open",
      apply: async (name) => {
        applied.push(name);
      },
    };
    const probe = new AppProbe({
      presets: port,
      createPane: (id, notify, commands) => {
        let pane: ConversationPane | undefined;
        const agent = new Agent({
          provider: new MockProvider([
            toolCallTurn({ type: "tool-call", callId: "c1", name: "scribble", arguments: {} }),
            textTurn("done"),
          ]),
          tools: [
            {
              name: "scribble",
              description: "writes",
              parameters: { type: "object" },
              mutates: true,
              execute: async () => {
                executed.push("scribble");
                return "wrote";
              },
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

    probe.command("preset");
    probe.keys("down", "enter", "y");
    await waitFor(() => expect(applied).toEqual(["open"]));
    expect(probe.model()?.pendingAsk).toBeDefined();
    expect(executed).toEqual([]);

    probe.keys("y");
    await probe.settled();
    expect(executed).toEqual(["scribble"]);
  });

  it("preset is absent when no port is wired", () => {
    expect(new AppProbe().command("preset")).toBe(false);
  });
});

describe("retrieval disclosure", () => {
  it("renders exactly once per session, quietly, in the feed", () => {
    const probe = new AppProbe();
    const pane = probe.core.panes.get("session-1") as ConversationPane;
    pane.discloseRetrieval("memory search uses embeddings from voyage-3");
    pane.discloseRetrieval("memory search uses embeddings from voyage-3");
    const disclosures = probe
      .model()
      ?.entries.filter((entry) => entry.kind === "info" && entry.text.includes("embeddings"));
    expect(disclosures).toEqual([
      { kind: "info", text: "memory search uses embeddings from voyage-3" },
    ]);
  });
});

describe("checkpoint-paired backtrack fork", () => {
  const treeHash = "a".repeat(40);

  function promptRoots(checkpoint?: string): SessionTreeNode[] {
    const second: SessionTreeNode = {
      entry: {
        type: "message",
        id: "u2",
        parentId: "a1",
        timestamp: "",
        message: textMessage("user", "two"),
        ...(checkpoint !== undefined && { checkpoint }),
      },
      children: [],
      onActivePath: true,
    };
    const reply: SessionTreeNode = {
      entry: {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "",
        message: textMessage("assistant", "re: one"),
      },
      children: [second],
      onActivePath: true,
    };
    return [
      {
        entry: {
          type: "message",
          id: "u1",
          parentId: null,
          timestamp: "",
          message: textMessage("user", "one"),
        },
        children: [reply],
        onActivePath: true,
      },
    ];
  }

  function forkWorld(options: { checkpoint?: string; restoreError?: Error } = {}) {
    const restored: string[] = [];
    const opened: (string | undefined)[] = [];
    const trees: SessionTreePort = {
      load: async (sessionId) => ({ sessionId, roots: promptRoots(options.checkpoint) }),
      setLabel: async () => {},
      fork: async () => "forked-1",
    };
    const checkpoints: CheckpointsPort = {
      capture: async () => {},
      undo: async () => false,
      redo: async () => false,
      restoreTo: async (tree) => {
        if (options.restoreError !== undefined) throw options.restoreError;
        restored.push(tree);
      },
    };
    return {
      restored,
      opened,
      fork: (ordinal: number, draft: string) =>
        forkAtPrompt(
          trees,
          (sessionId) => opened.push(sessionId),
          checkpoints,
          "s1",
          ordinal,
          draft,
        ),
    };
  }

  it("restores files to the prompt's checkpoint and says so", async () => {
    const world = forkWorld({ checkpoint: treeHash });
    const outcome = await world.fork(1, "two");
    expect(outcome).toEqual({ forked: true, note: "files put back to that point" });
    expect(world.restored).toEqual([treeHash]);
    expect(world.opened).toEqual(["forked-1"]);
  });

  it("forks truthfully without touching files when the prompt was never checkpointed", async () => {
    const world = forkWorld();
    const outcome = await world.fork(1, "two");
    expect(outcome).toEqual({ forked: true, note: "forked · files untouched" });
    expect(world.restored).toEqual([]);
    expect(world.opened).toEqual(["forked-1"]);
  });

  it("keeps the conversation fork alive when the file restore fails, and says why", async () => {
    const world = forkWorld({ checkpoint: treeHash, restoreError: new Error("disk detached") });
    const outcome = await world.fork(1, "two");
    expect(world.opened).toEqual(["forked-1"]);
    expect(outcome).toEqual({
      forked: true,
      note: "forked · file restore failed: disk detached",
    });
  });

  it("skips restoring when no checkpoint store is available", async () => {
    const opened: (string | undefined)[] = [];
    const trees: SessionTreePort = {
      load: async (sessionId) => ({ sessionId, roots: promptRoots(treeHash) }),
      setLabel: async () => {},
      fork: async () => "forked-1",
    };
    const outcome = await forkAtPrompt(
      trees,
      (sessionId) => opened.push(sessionId),
      undefined,
      "s1",
      1,
      "two",
    );
    expect(outcome).toEqual({ forked: true, note: "forked · files untouched" });
    expect(opened).toEqual(["forked-1"]);
  });

  it("surfaces the restore note quietly in the transcript after enter-fork", async () => {
    const probe = new AppProbe({
      createPane: (id, notify, commands) => {
        const agent = new Agent({ provider: new MockProvider([textTurn("re: one")]) });
        return new ConversationPane(id, agent, notify, undefined, commands, {
          ports: {
            forkAtPrompt: async () => ({ forked: true, note: "files put back to that point" }),
          },
        });
      },
    });
    probe.type("one").keys("enter");
    await probe.settled();
    probe.keys("escape", "escape", "enter");
    await probe.settled();
    expect(probe.model()?.entries.at(-1)).toEqual({
      kind: "info",
      text: "files put back to that point",
    });
  });
});

describe("mcp status pane wiring", () => {
  function mcpFactory(servers: McpServerView[] = []) {
    const port: McpPanePort = {
      load: async () => servers,
      restart: async () => {},
      setEnabled: async () => {},
      listTools: async () => [],
    };
    return (id: string, notify: () => void) => new McpPane(id, notify, port);
  }

  it("auto-docks the pane on the right at startup without stealing focus", async () => {
    const probe = new AppProbe({
      createMcpPane: mcpFactory([{ name: "files", state: "connected", toolCount: 2 }]),
    });
    await probe.settled();
    expect(paneIds(probe)).toEqual(["session-1", "mcp-1"]);
    expect(dockedIds(probe)).toEqual(["mcp-1"]);
    expect(dockOf(probe, "mcp-1")).toBe("right");
    expect(probe.snapshot().focused).toBe("session-1");
  });

  it("a fresh start seeds sessions left, chat in main, mcp right, chat focused", async () => {
    const probe = new AppProbe({
      createMcpPane: mcpFactory(),
      createSessionTreePane: (id) => stubFilePane(id, "sessions"),
    });
    await probe.settled();
    expect(paneIds(probe)).toEqual(["tree-1", "session-1", "mcp-1"]);
    expect(dockOf(probe, "tree-1")).toBe("left");
    expect(dockOf(probe, "session-1")).toBeUndefined();
    expect(dockOf(probe, "mcp-1")).toBe("right");
    expect(probe.snapshot().focused).toBe("session-1");
  });

  it("per-side defaults: mcp homes right while the browser homes left", async () => {
    const probe = new AppProbe({
      createMcpPane: mcpFactory(),
      createBrowserPane: (id) => stubFilePane(id, "workspace"),
    });
    await probe.settled();
    probe.command("browse");
    expect(dockOf(probe, "browser-1")).toBe("left");
    expect(dockOf(probe, "mcp-1")).toBe("right");
    expect(paneIds(probe)).toEqual(["browser-1", "session-1", "mcp-1"]);
  });

  it("/mcp summons and refocuses the pane instead of duplicating it", async () => {
    const probe = new AppProbe({ createMcpPane: mcpFactory() });
    await probe.settled();
    probe.type("/mcp").keys("enter");
    expect(probe.snapshot().focused).toBe("mcp-1");
    expect(paneIds(probe)).toEqual(["session-1", "mcp-1"]);
  });

  it("with zero servers configured the pane never exists and /mcp is absent", () => {
    const probe = new AppProbe();
    expect(paneIds(probe)).toEqual(["session-1"]);
    expect(probe.command("mcp")).toBe(false);
  });

  it("revives a saved mcp pane without double-docking a second one", async () => {
    const first = new AppProbe({ createMcpPane: mcpFactory() });
    await first.settled();
    const state = mustParse(JSON.parse(JSON.stringify(first.workspaceState())));
    expect(state.panes.map((pane) => pane.kind)).toContain("mcp");

    const revived = new AppProbe({ createMcpPane: mcpFactory(), restoreWorkspace: state });
    await revived.settled();
    expect(paneIds(revived).filter((id) => id.startsWith("mcp-"))).toEqual(["mcp-1"]);
  });
});

function paneContext() {
  return { theme: resolveTheme(), focused: true, width: 60, height: 20 };
}

function describePaneTree(node: unknown): unknown {
  if (node === null || typeof node !== "object") return node;
  const record = node as { props?: { content?: unknown }; children?: unknown[] };
  return {
    ...(record.props?.content !== undefined && { content: record.props.content }),
    ...(Array.isArray(record.children) && { children: record.children.map(describePaneTree) }),
  };
}
