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

  it("the fresh workspace ships unpinned and pins survive a restore at the head of the dock", () => {
    const fresh = new AppProbe();
    expect(pinnedIds(fresh)).toEqual([]);
    const probe = new AppProbe();
    probe.command("split");
    probe.command("dock-left");
    probe.command("split");
    probe.command("dock-left");
    probe.command("pin");
    expect(dockedIds(probe)).toEqual(["session-3", "session-2"]);
    const restored = new AppProbe({ restoreWorkspace: mustParse(probe.workspaceState()) });
    expect(dockedIds(restored)).toEqual(["session-3", "session-2"]);
    expect(pinnedIds(restored)).toEqual(["session-3"]);
  });

  it("leader i is the palette's leader spelling now that leader p pins", () => {
    const probe = new AppProbe().keys("ctrl+k", "i");
    expect(probe.snapshot().overlay).toBe("palette");
    expect(probe.core.paletteMode).toBe("commands");
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

describe("armed indicator expiry", () => {
  it("clears leaderArmed once the keymap's arm window lapses", () => {
    const probe = new AppProbe().keys("ctrl+k");
    expect(probe.snapshot().leaderArmed).toBe(true);

    probe.core.expireArmed(10_000);
    expect(probe.snapshot().leaderArmed).toBe(false);
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
    probe.click(shrunk.x + shrunk.width - 2, shrunk.y + 1);
    expect(probe.snapshot().focused).toBe("session-1");
    const grown = probe.rect("session-2");
    probe.click(grown.x + 1, grown.y + 1);
    expect(probe.snapshot().focused).toBe("session-2");
  });

  it("keeps the shared border as a resize grip, never a focus target", () => {
    const probe = new AppProbe();
    probe.command("split");
    const first = probe.rect("session-1");
    probe.click(first.x + first.width - 1, first.y + 1);
    expect(probe.snapshot().focused).toBe("session-2");
    const before = probe.rect("session-1").width;
    probe.drag(
      { x: first.x + first.width - 1, y: first.y + 1 },
      { x: first.x + first.width + 5, y: first.y + 1 },
    );
    expect(probe.rect("session-1").width).toBeGreaterThan(before);
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

  it("lands at the main edge toward the cluster's dock when none of the cluster is on screen", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.command("dock-left");
    probe.core.focusPane("session-1");
    probe.command("split");
    expect(probe.core.holdPane("session-3")).toBe(true);
    expect(probe.core.showPane("session-3", ["session-2"])).toBe(true);
    const edge = probe.rect("session-3");
    const main = probe.rect("session-1");
    expect(edge.x < main.x && edge.height === main.height).toBe(true);
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

  it("drags the outer vertical seam without stealing focus from the pane under it", () => {
    const probe = nestedProbe();
    probe.core.focusPane("session-1");
    const first = probe.rect("session-1");
    const seam = { x: first.x + first.width - 1, y: 30 };
    probe.drag(seam, { x: seam.x + 10, y: 30 });
    expect(probe.rect("session-1").width).toBeGreaterThan(first.width);
    expect(probe.snapshot().focused).toBe("session-1");
    assertGapless(probe);
  });

  it("persists a dragged ratio through the workspace file and survives zoom unchanged", () => {
    const probe = nestedProbe();
    const lower = probe.rect("session-3");
    probe.drag({ x: lower.x + 5, y: lower.y - 1 }, { x: lower.x + 5, y: lower.y + 6 });
    const dragged = tiles(probe);
    expect(dragged).not.toEqual(tiles(nestedProbe()));
    const restored = new AppProbe({ restoreWorkspace: mustParse(probe.workspaceState()) });
    expect(tiles(restored)).toEqual(dragged);
    probe.keys("ctrl+k", "z");
    expect(probe.snapshot().zoomed).toBeDefined();
    probe.keys("z");
    expect(tiles(probe)).toEqual(dragged);
    expect(JSON.stringify(probe.workspaceState().layout)).toBe(
      JSON.stringify(restored.workspaceState().layout),
    );
  });
});
