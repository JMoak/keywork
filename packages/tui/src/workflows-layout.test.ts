import { Agent, MockProvider, textTurn } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { ConversationPane } from "./conversation-pane.ts";
import type { Rect } from "./geometry.ts";
import { AppProbe } from "./probe.ts";
import { waitFor } from "./testing/index.ts";
import {
  dockedIds,
  dockOf,
  mustParse,
  paneIds,
  pinnedIds,
  stubFilePane,
} from "./testing/workflow-probe.ts";

describe("split and sticky navigation", () => {
  it("splits twice from a single leader press", () => {
    const probe = new AppProbe().keys("ctrl+k", "s", "s");
    expect(paneIds(probe)).toEqual(["session-1", "session-2", "session-3"]);
    expect(probe.snapshot().focused).toBe("session-3");
    expect(probe.snapshot().leaderArmed).toBe(true);
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

  it("pins head their dock, toggle on leader p, and refuse main-area panes", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.command("split");
    probe.core.focusPane("session-2");
    probe.command("dock-left");
    probe.core.focusPane("session-3");
    probe.command("dock-left");
    expect(dockedIds(probe)).toEqual(["session-2", "session-3"]);
    probe.keys("ctrl+k", "p");
    expect(dockedIds(probe)).toEqual(["session-3", "session-2"]);
    expect(pinnedIds(probe)).toEqual(["session-3"]);
    probe.keys("ctrl+k", "p");
    expect(pinnedIds(probe)).toEqual([]);
    expect(dockedIds(probe)).toEqual(["session-3", "session-2"]);
    expect(probe.command("pin")).toBe(true);
    expect(pinnedIds(probe)).toEqual(["session-3"]);
    expect(probe.command("unpin")).toBe(true);
    expect(pinnedIds(probe)).toEqual([]);
    probe.core.focusPane("session-1");
    expect(dockOf(probe, "session-1")).toBeUndefined();
    probe.keys("ctrl+k", "p");
    expect(probe.snapshot().notice).toBe("pins are for docked panes · dock it first");
    expect(pinnedIds(probe)).toEqual([]);
  });

  it("the initial workspace is declared, pins included", () => {
    const probe = new AppProbe({
      createSessionTreePane: (id) => stubFilePane(id, "tree"),
      initialWorkspace: [{ kind: "conversation" }, { kind: "session-tree", pinned: true }],
    });
    expect(paneIds(probe)).toEqual(["tree-1", "session-1"]);
    expect(pinnedIds(probe)).toEqual(["tree-1"]);
    expect(probe.snapshot().focused).toBe("session-1");
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
  it("lets / start slash input after a sticky action instead of opening help", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.keys("ctrl+k", "h", "/");
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(probe.model()?.input).toBe("/");
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
});

describe("modified chords while the leader is armed", () => {
  it("does not close a pane on ctrl+x during an armed leader", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.keys("ctrl+k", "ctrl+x");
    expect(paneIds(probe)).toEqual(["session-1", "session-2"]);
    expect(probe.exited).toBe(false);
  });
});

describe("split refusal", () => {
  it("refuses a split below minimum pane size with a status notice", () => {
    const probe = new AppProbe({ screen: { width: 9, height: 5 } });
    probe.keys("ctrl+k", "s");
    expect(paneIds(probe)).toEqual(["session-1"]);
    expect(probe.snapshot().notice).toContain("no room");
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
});

describe("held panes", () => {
  it("holds a pane off the layout but alive, and shows it again beside its cluster's most recent focus", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.command("split");
    expect(probe.core.holdPane("session-2")).toBe(true);
    expect(paneIds(probe)).toEqual(["session-1", "session-3"]);
    expect(probe.snapshot().held).toEqual(["session-2"]);
    expect(probe.core.panes.has("session-2")).toBe(true);
    expect(probe.workspaceState().held.map((pane) => pane.id)).toEqual(["session-2"]);

    probe.core.focusPane("session-1");
    const anchorBefore = probe.rect("session-1");
    const otherBefore = probe.rect("session-3");
    expect(probe.core.showPane("session-2", ["session-1", "session-3"])).toBe(true);
    expect(probe.snapshot().held).toEqual([]);
    expect(probe.snapshot().focused).toBe("session-1");
    const anchorAfter = probe.rect("session-1");
    const anchorSplit =
      anchorAfter.width < anchorBefore.width || anchorAfter.height < anchorBefore.height;
    expect(anchorSplit).toBe(true);
    expect(probe.rect("session-3")).toEqual(otherBefore);
  });

  it("focusing a held pane brings it back beside the focus; the last visible pane cannot be held", () => {
    const probe = new AppProbe();
    probe.command("split");
    expect(probe.core.holdPane("session-1")).toBe(true);
    expect(probe.core.holdPane("session-2")).toBe(false);
    probe.core.focusPane("session-1");
    expect(paneIds(probe).sort()).toEqual(["session-1", "session-2"]);
    expect(probe.snapshot().focused).toBe("session-1");
    expect(probe.snapshot().held).toEqual([]);
  });

  it("closing the last visible pane brings held panes back instead of quitting", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.core.holdPane("session-1");
    probe.core.closePane();
    expect(probe.exited).toBe(false);
    expect(paneIds(probe)).toEqual(["session-1"]);
    expect(probe.snapshot().held).toEqual([]);
  });

  it("held panes persist apart from the layout and restore held", () => {
    const first = new AppProbe();
    first.command("split");
    (first.core.panes.get("session-1") as ConversationPane).sessionId = "sess-a";
    (first.core.panes.get("session-2") as ConversationPane).sessionId = "sess-b";
    first.core.holdPane("session-1");
    const state = mustParse(JSON.parse(JSON.stringify(first.workspaceState())));
    expect(state.held).toEqual([{ id: "session-1", kind: "conversation", sessionId: "sess-a" }]);

    const second = new AppProbe({
      restoreWorkspace: state,
      createPane: (id, notify, commands, resumeSessionId) => {
        const pane = new ConversationPane(id, undefined, notify, undefined, commands);
        pane.sessionId = resumeSessionId;
        return pane;
      },
    });
    expect(paneIds(second)).toEqual(["session-2"]);
    expect(second.snapshot().held).toEqual(["session-1"]);
    expect((second.core.panes.get("session-1") as ConversationPane).sessionId).toBe("sess-a");
    second.core.focusPane("session-1");
    expect(paneIds(second).sort()).toEqual(["session-1", "session-2"]);
    expect(second.snapshot().held).toEqual([]);
  });
});

describe("interior seam drag-resize", () => {
  function tiles(probe: AppProbe): Rect[] {
    return paneIds(probe).map((id) => probe.rect(id));
  }

  function assertGapless(probe: AppProbe): void {
    const area = tiles(probe).reduce((sum, rect) => sum + rect.width * rect.height, 0);
    expect(area).toBe(probe.screen.width * probe.screen.height);
  }

  function nestedProbe(): AppProbe {
    const probe = new AppProbe();
    probe.command("split");
    probe.command("split");
    return probe;
  }

  it("drags a nested horizontal seam live, commits on release, and stays gapless at every position", () => {
    const probe = nestedProbe();
    const upper = probe.rect("session-2");
    const lower = probe.rect("session-3");
    expect(lower.x).toBe(upper.x);
    const seam = { x: upper.x + 5, y: lower.y - 1 };
    probe.dragHold(seam, { x: seam.x, y: seam.y + 4 });
    expect(probe.rect("session-2").height).toBe(upper.height + 4);
    assertGapless(probe);
    probe.release({ x: seam.x, y: seam.y + 4 });
    expect(probe.rect("session-2").height).toBe(upper.height + 4);
    for (let y = 0; y < probe.screen.height; y += 1) {
      probe.drag({ x: seam.x, y: probe.rect("session-3").y - 1 }, { x: seam.x, y });
      assertGapless(probe);
    }
  });
});

describe("discarding a pane by id", () => {
  it("disposes and closes any pane but the last visible one, held or shown", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.command("split");
    expect(probe.core.holdPane("session-2")).toBe(true);
    expect(probe.core.discardPane("session-2")).toBe(true);
    expect(probe.core.panes.has("session-2")).toBe(false);
    expect(probe.snapshot().held).toEqual([]);
    expect(probe.core.discardPane("session-3")).toBe(true);
    expect(paneIds(probe)).toEqual(["session-1"]);
    expect(probe.core.discardPane("session-1")).toBe(false);
    expect(probe.core.discardPane("session-9")).toBe(false);
    expect(paneIds(probe)).toEqual(["session-1"]);
  });
});
