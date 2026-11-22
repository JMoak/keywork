import { type SessionTreeNode, textMessage } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import type { FrameScheduler } from "./frame-scheduler.ts";
import { parseChord } from "./keys.ts";
import type { PaneIntents } from "./pane.ts";
import type { ForkOrigin, SessionTreeView } from "./session-tree-model.ts";
import { busyRemovalNotice, SessionTreePane, type SessionTreePort } from "./session-tree-pane.ts";
import type {
  SessionGroupBy,
  SessionOverviewItem,
  SessionPresence,
} from "./sessions-overview-model.ts";
import { press } from "./testing/index.ts";
import { describePaneTree, paneContext } from "./testing/workflow-probe.ts";

interface TreeWorld {
  items: SessionOverviewItem[];
  entriesBySession: Map<string, string[]>;
  overviewLoads: number;
  entryLoads: string[];
  attached: string[];
  forkedFrom: string[];
  unsubscribed: number;
  listeners: Array<(sessionId: string) => void>;
  trashed: SessionOverviewItem[];
  removed: string[];
  restored: string[];
  origin?: ForkOrigin;
}

interface RecordedIntents {
  intents: PaneIntents;
  opened: string[];
  focused: string[];
  closed: string[];
  notices: string[];
}

function itemOf(id: string, modifiedAt = 0): SessionOverviewItem {
  return {
    id,
    title: `title-${id}`,
    createdAt: modifiedAt,
    modifiedAt,
    entryCount: 2,
    branchCount: 0,
    labelCount: 0,
  };
}

function worldOf(...sessionIds: string[]): TreeWorld {
  return {
    items: sessionIds.map((id, at) => itemOf(id, sessionIds.length - at)),
    entriesBySession: new Map(sessionIds.map((id) => [id, [`${id}-e1`, `${id}-e2`]])),
    overviewLoads: 0,
    entryLoads: [],
    attached: [],
    forkedFrom: [],
    unsubscribed: 0,
    listeners: [],
    trashed: [],
    removed: [],
    restored: [],
  };
}

function chainView(
  sessionId: string,
  entryIds: readonly string[],
  origin?: ForkOrigin,
): SessionTreeView {
  return {
    sessionId,
    name: `name-${sessionId}`,
    roots: chainNodes(entryIds, null),
    ...(origin !== undefined && { forkedFrom: origin }),
  };
}

function chainNodes(ids: readonly string[], parentId: string | null): SessionTreeNode[] {
  const [head, ...rest] = ids;
  if (head === undefined) return [];
  return [
    {
      entry: {
        type: "message",
        id: head,
        parentId,
        timestamp: "",
        message: textMessage("user", head),
      },
      children: chainNodes(rest, head),
      onActivePath: true,
    },
  ];
}

function portOver(world: TreeWorld, forkResult: () => Promise<string | undefined>) {
  const port: SessionTreePort = {
    overview: async () => {
      world.overviewLoads += 1;
      return [...world.items];
    },
    load: async (sessionId) => {
      world.entryLoads.push(sessionId);
      const entries = world.entriesBySession.get(sessionId);
      return entries === undefined ? undefined : chainView(sessionId, entries, world.origin);
    },
    setLabel: async () => {},
    fork: async (_sessionId, entryId) => {
      world.forkedFrom.push(entryId);
      return forkResult();
    },
    attach: async (sessionId) => {
      world.attached.push(sessionId);
      return true;
    },
    subscribe: (listener) => {
      world.listeners.push(listener);
      return () => {
        world.unsubscribed += 1;
      };
    },
    remove: async (sessionId) => {
      if (!world.items.some((item) => item.id === sessionId)) return "missing";
      world.removed.push(sessionId);
      const [gone] = world.items.splice(
        world.items.findIndex((item) => item.id === sessionId),
        1,
      );
      if (gone !== undefined) world.trashed.push(gone);
      return "removed";
    },
    trash: async () => [...world.trashed],
    restore: async (sessionId) => {
      const at = world.trashed.findIndex((item) => item.id === sessionId);
      if (at === -1) return undefined;
      const [back] = world.trashed.splice(at, 1);
      if (back === undefined) return undefined;
      world.restored.push(sessionId);
      world.items.push(back);
      return back;
    },
  };
  return port;
}

function recordedIntents(): RecordedIntents {
  const opened: string[] = [];
  const focused: string[] = [];
  const closed: string[] = [];
  const notices: string[] = [];
  return {
    opened,
    focused,
    closed,
    notices,
    intents: {
      openFile: () => {},
      openSession: (sessionId) => opened.push(sessionId),
      focusPane: (id) => focused.push(id),
      notice: (text) => notices.push(text),
      closePane: (id) => {
        closed.push(id);
        return true;
      },
    },
  };
}

interface ManualFrames {
  scheduleFrame: FrameScheduler;
  pendingCount(): number;
  runPending(): void;
}

function manualFrames(): ManualFrames {
  const pending: Array<() => void> = [];
  return {
    scheduleFrame: (run) => {
      pending.push(run);
      return () => {
        const at = pending.indexOf(run);
        if (at !== -1) pending.splice(at, 1);
      };
    },
    pendingCount: () => pending.length,
    runPending: () => {
      for (const run of pending.splice(0)) run();
    },
  };
}

interface PaneSetup {
  presence?: SessionPresence;
  sessionId?: string;
  groupBy?: SessionGroupBy;
  now?: () => number;
  forkResult?: () => Promise<string | undefined>;
  notify?: () => void;
  frames?: ManualFrames;
}

function paneOver(world: TreeWorld, setup: PaneSetup = {}) {
  const recorded = recordedIntents();
  const port = portOver(world, setup.forkResult ?? (async () => "forked-1"));
  const pane = new SessionTreePane(
    "tree-1",
    setup.notify ?? (() => {}),
    recorded.intents,
    port,
    () => world.items[0]?.id,
    {
      ...(setup.sessionId !== undefined && { sessionId: setup.sessionId }),
      ...(setup.groupBy !== undefined && { groupBy: setup.groupBy }),
      ...(setup.now !== undefined && { now: setup.now }),
      botSigil: (name) => (name === "reviewer" ? "⚖" : undefined),
      ...(setup.presence !== undefined && { presence: setup.presence }),
      ...(setup.frames !== undefined && { scheduleFrame: setup.frames.scheduleFrame }),
    },
  );
  return { pane, recorded, port };
}

describe("SessionTreePane two levels", () => {
  it("opens at the overview listing every session, most recent first", async () => {
    const world = worldOf("s1", "s2");
    const { pane } = paneOver(world);
    await pane.settled();
    expect(pane.level()).toBe("overview");
    expect(pane.overview.sessionRows().map((row) => row.id)).toEqual(["s1", "s2"]);
    expect(pane.title()).toBe(" session tree · 2 sessions ");
  });

  it("l drills into the cursored session's entry tree and esc returns", async () => {
    const world = worldOf("s1", "s2");
    const { pane } = paneOver(world);
    await pane.settled();
    press(pane, "j", "l");
    await pane.settled();
    expect(pane.level()).toBe("entries");
    expect(pane.model.sessionId()).toBe("s2");
    expect(pane.title()).toBe(" name-s2 · 2 entries ");
    press(pane, "escape");
    await pane.settled();
    expect(pane.level()).toBe("overview");
  });

  it("labels keep the typed case: Shift+H then i reads back Hi", async () => {
    const world = worldOf("s1");
    const { pane } = paneOver(world);
    await pane.settled();
    press(pane, "l");
    await pane.settled();
    press(pane, "shift+l");
    pane.handleKey(parseChord("shift+h"), "H");
    pane.handleKey(parseChord("i"), "i");
    expect(pane.model.labelDraft).toBe("Hi");
    press(pane, "escape");
  });

  it("esc at the entries level cancels the label editor before leaving", async () => {
    const world = worldOf("s1");
    const { pane } = paneOver(world);
    await pane.settled();
    press(pane, "l");
    await pane.settled();
    press(pane, "shift+l", "x");
    expect(pane.model.labeling).toBe(true);
    press(pane, "escape");
    expect(pane.model.labeling).toBe(false);
    expect(pane.level()).toBe("entries");
    press(pane, "escape");
    expect(pane.level()).toBe("overview");
  });

  it("a stale persisted descriptor revives into the overview without error", async () => {
    const world = worldOf("s1", "s2");
    const { pane } = paneOver(world, { sessionId: "s2" });
    await pane.settled();
    expect(pane.level()).toBe("overview");
    expect(pane.overview.rows()).toHaveLength(2);
    expect(pane.describe()).toEqual({ kind: "session-tree", sessionId: "s2" });
  });
});

describe("SessionTreePane focus-or-open", () => {
  it("enter focuses the pane already showing the cursored session", async () => {
    const world = worldOf("s1", "s2");
    const presence: SessionPresence = {
      paneFor: (sessionId) => (sessionId === "s1" ? "session-9" : undefined),
      busy: () => false,
      waiting: () => false,
    };
    const { pane, recorded } = paneOver(world, { presence });
    await pane.settled();
    press(pane, "enter");
    await pane.settled();
    expect(recorded.focused).toEqual(["session-9"]);
    expect(recorded.opened).toEqual([]);
    expect(world.attached).toEqual([]);
  });

  it("enter attaches then opens a resumed pane when no pane holds the session", async () => {
    const world = worldOf("s1", "s2");
    const presence: SessionPresence = {
      paneFor: () => undefined,
      busy: () => false,
      waiting: () => false,
    };
    const { pane, recorded } = paneOver(world, { presence });
    await pane.settled();
    press(pane, "j", "enter");
    await pane.settled();
    expect(world.attached).toEqual(["s2"]);
    expect(recorded.opened).toEqual(["s2"]);
    expect(recorded.focused).toEqual([]);
  });

  it("a click on a session row activates it, focusing its open chat", async () => {
    const world = worldOf("s1", "s2");
    const presence: SessionPresence = {
      paneFor: (sessionId) => (sessionId === "s2" ? "session-7" : undefined),
      busy: () => false,
      waiting: () => false,
    };
    const { pane, recorded } = paneOver(world, { presence });
    await pane.settled();
    expect(pane.handleMouse({ x: 3, y: 2 }, { type: "down", x: 3, y: 2 })).toBe(true);
    await pane.settled();
    expect(pane.overview.cursor).toBe(1);
    expect(recorded.focused).toEqual(["session-7"]);
    expect(recorded.opened).toEqual([]);
  });

  it("an activation landing after dispose opens nothing", async () => {
    const world = worldOf("s1");
    let releaseAttach: (ok: boolean) => void = () => {};
    const { pane, recorded, port } = paneOver(world);
    port.attach = () =>
      new Promise((resolve) => {
        releaseAttach = resolve;
      });
    await pane.settled();
    press(pane, "enter");
    pane.dispose();
    releaseAttach(true);
    await pane.settled();
    expect(recorded.opened).toEqual([]);
  });
});

describe("SessionTreePane push refresh", () => {
  it("a pushed change re-lists the overview within a frame, coalescing bursts", async () => {
    const world = worldOf("s1");
    const frames = manualFrames();
    const { pane } = paneOver(world, { frames });
    await pane.settled();
    expect(world.overviewLoads).toBe(1);

    world.items = [itemOf("s2", 9), ...world.items];
    world.entriesBySession.set("s2", ["s2-e1"]);
    for (const listener of world.listeners) {
      listener("s2");
      listener("s2");
      listener("s2");
    }
    expect(world.overviewLoads).toBe(1);
    expect(frames.pendingCount()).toBe(1);
    frames.runPending();
    await pane.settled();
    expect(world.overviewLoads).toBe(2);
    expect(pane.overview.sessionRows().map((row) => row.id)).toEqual(["s2", "s1"]);
  });

  it("a pushed change refreshes the drilled entry tree, not the overview", async () => {
    const world = worldOf("s1");
    const frames = manualFrames();
    const { pane } = paneOver(world, { frames });
    await pane.settled();
    press(pane, "l");
    await pane.settled();
    expect(world.entryLoads).toEqual(["s1"]);

    world.entriesBySession.set("s1", ["s1-e1", "s1-e2", "s1-e3"]);
    for (const listener of world.listeners) listener("s1");
    frames.runPending();
    await pane.settled();
    expect(world.entryLoads).toEqual(["s1", "s1"]);
    expect(pane.model.entryCount()).toBe(3);
  });

  it("unsubscribes and cancels a pending refresh on dispose", async () => {
    const world = worldOf("s1");
    const frames = manualFrames();
    const { pane } = paneOver(world, { frames });
    await pane.settled();
    for (const listener of world.listeners) listener("s1");
    expect(frames.pendingCount()).toBe(1);
    pane.dispose();
    expect(frames.pendingCount()).toBe(0);
    frames.runPending();
    await pane.settled();
    expect(world.unsubscribed).toBe(1);
    expect(world.overviewLoads).toBe(1);
  });
});

describe("SessionTreePane property: the active level's cursor always lands on a visible row", () => {
  it("holds for any random op sequence across both levels over shifting state", async () => {
    const world = worldOf("s1", "s2", "s3", "s4", "s5");
    let alternate = false;
    const port = portOver(world, async () => undefined);
    port.overview = async () => {
      alternate = !alternate;
      world.items = alternate
        ? ["s1", "s2", "s3", "s4", "s5"].map((id, at) => itemOf(id, 5 - at))
        : [itemOf("s2", 2), itemOf("s4", 1)];
      return [...world.items];
    };
    port.load = async (sessionId) => {
      world.entryLoads.push(sessionId);
      const length = alternate ? 23 : 7;
      return chainView(
        sessionId,
        Array.from({ length }, (_, at) => `${sessionId}-e${at}`),
      );
    };
    const recorded = recordedIntents();
    const pane = new SessionTreePane(
      "tree-1",
      () => {},
      recorded.intents,
      port,
      () => "s2",
    );
    await pane.settled();

    const ops = [
      "j",
      "k",
      "l",
      "h",
      "enter",
      "escape",
      "backspace",
      "r",
      "f",
      "pagedown",
      "pageup",
      "shift+l",
      "x",
    ];
    let seed = 17;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let step = 0; step < 500; step += 1) {
      press(pane, ops[Math.floor(random() * ops.length)] as string);
      await pane.settled();
      const { cursor, rowCount, visibleIndexes } = cursorSnapshot(pane);
      if (rowCount === 0) continue;
      expect(cursor).toBeGreaterThanOrEqual(0);
      expect(cursor).toBeLessThan(rowCount);
      expect(visibleIndexes).toContain(cursor);
    }
  });
});

function cursorSnapshot(pane: SessionTreePane): {
  cursor: number;
  rowCount: number;
  visibleIndexes: number[];
} {
  if (pane.level() === "overview") {
    const rowCount = pane.overview.rows().length;
    const visibleIndexes = pane.overview.visibleRows(4).map(({ index }) => index);
    return { cursor: pane.overview.cursor, rowCount, visibleIndexes };
  }
  const rowCount = pane.model.rows().length;
  const visibleIndexes = pane.model.visibleRows(4).map(({ index }) => index);
  return { cursor: pane.model.cursor, rowCount, visibleIndexes };
}

describe("SessionTreePane command tray", () => {
  it("opens on / at the overview and enter runs open on the cursored session", async () => {
    const world = worldOf("s1", "s2");
    const { pane, recorded } = paneOver(world);
    await pane.settled();
    press(pane, "/");
    expect(pane.tray.open).toBe(true);
    expect(pane.tray.matches().map((command) => command.name)).toEqual([
      "open",
      "entries",
      "group",
      "remove",
      "trash",
      "empty trash",
      "refresh",
    ]);
    press(pane, "enter");
    await pane.settled();
    expect(pane.tray.open).toBe(false);
    expect(recorded.opened).toEqual(["s1"]);
  });

  it("never opens while a label is being typed", async () => {
    const world = worldOf("s1");
    const { pane } = paneOver(world);
    await pane.settled();
    press(pane, "l");
    await pane.settled();
    press(pane, "shift+l", "/");
    expect(pane.tray.open).toBe(false);
    expect(pane.model.labeling).toBe(true);
  });
});

describe("SessionTreePane group-by", () => {
  function groupedWorld(): TreeWorld {
    const world = worldOf("s1", "s2", "s3", "s4");
    world.items = [
      { ...itemOf("s1", 40), bot: "reviewer", arc: "dock-v2" },
      { ...itemOf("s2", 30), arc: "dock-v2" },
      { ...itemOf("s3", 20), bot: "scout" },
      { ...itemOf("s4", 10), bot: "reviewer" },
    ];
    return world;
  }

  it("g cycles none · arc · bot, and the descriptor carries the axis so it revives", async () => {
    const { pane } = paneOver(groupedWorld());
    await pane.settled();
    expect(pane.describe()).toEqual({ kind: "session-tree" });
    press(pane, "g");
    expect(pane.overview.groupBy()).toBe("arc");
    expect(pane.describe()).toEqual({ kind: "session-tree", groupBy: "arc" });
    press(pane, "g");
    expect(pane.describe()).toEqual({ kind: "session-tree", groupBy: "bot" });
    press(pane, "g");
    expect(pane.describe()).toEqual({ kind: "session-tree" });
  });
});

describe("SessionTreePane removal and the trash", () => {
  const presenceOf = (
    paneFor: (sessionId: string) => string | undefined,
    busy: (sessionId: string) => boolean = () => false,
  ): SessionPresence => ({ paneFor, busy, waiting: () => false });

  it("x asks in-pane, enter closes the session's pane and trashes it, then relists", async () => {
    const world = worldOf("s1", "s2");
    const { pane, recorded } = paneOver(world, {
      presence: presenceOf((sessionId) => (sessionId === "s1" ? "session-9" : undefined)),
    });
    await pane.settled();
    const loads = world.overviewLoads;
    press(pane, "x");
    expect(pane.overview.removalPrompt()).toContain('remove "title-s1"?');
    expect(JSON.stringify(describePaneTree(pane.view(paneContext())))).toContain(
      'remove \\"title-s1\\"?',
    );
    press(pane, "enter");
    await pane.settled();
    expect(recorded.closed).toEqual(["session-9"]);
    expect(world.removed).toEqual(["s1"]);
    expect(recorded.notices).toEqual([
      'removed "title-s1" · t in the session tree restores it, memory notes stay',
    ]);
    expect(world.overviewLoads).toBe(loads + 1);
    expect(pane.overview.sessionRows().map((row) => row.id)).toEqual(["s2"]);
  });

  it("refuses while the session's turn is running and leaves its pane alone", async () => {
    const world = worldOf("s1");
    const { pane, recorded } = paneOver(world, {
      presence: presenceOf(
        () => "session-9",
        () => true,
      ),
    });
    await pane.settled();
    press(pane, "x", "enter");
    await pane.settled();
    expect(recorded.closed).toEqual([]);
    expect(world.removed).toEqual([]);
    expect(recorded.notices).toEqual([busyRemovalNotice]);
  });

  it("any other key cancels, and a port without remove has no x key", async () => {
    const world = worldOf("s1", "s2");
    const { pane } = paneOver(world);
    await pane.settled();
    press(pane, "x", "j");
    await pane.settled();
    expect(pane.overview.removal()).toBeUndefined();
    expect(world.removed).toEqual([]);
    expect(pane.overview.cursorSession()).toBe("s1");

    const bare: SessionTreePort = {
      load: async () => undefined,
      setLabel: async () => {},
      fork: async () => undefined,
      overview: async () => [itemOf("s1")],
    };
    const plain = new SessionTreePane(
      "tree-2",
      () => {},
      recordedIntents().intents,
      bare,
      () => "s1",
    );
    await plain.settled();
    expect(plain.handleKey(parseChord("x"))).toBe(false);
    expect(plain.handleKey(parseChord("t"))).toBe(false);
  });

  it("t shows the trash, enter restores the cursored session, escape returns", async () => {
    const world = worldOf("s1");
    world.trashed = [itemOf("gone", 5)];
    const { pane, recorded } = paneOver(world);
    await pane.settled();
    press(pane, "t");
    await pane.settled();
    expect(pane.level()).toBe("trash");
    expect(pane.title()).toBe(" trash · 1 session ");
    expect(pane.trashed.sessionRows().map((row) => row.id)).toEqual(["gone"]);
    press(pane, "/");
    expect(pane.tray.matches().map((command) => command.name)).toEqual([
      "restore",
      "delete",
      "empty",
      "back",
      "refresh",
    ]);
    press(pane, "escape");
    press(pane, "enter");
    await pane.settled();
    expect(world.restored).toEqual(["gone"]);
    expect(recorded.notices).toEqual([`restored "title-gone" · it's back in the session tree`]);
    expect(pane.title()).toBe(" trash ");
    press(pane, "escape");
    await pane.settled();
    expect(pane.level()).toBe("overview");
    expect(pane.overview.sessionRows().map((row) => row.id)).toEqual(["gone", "s1"]);
  });
});
