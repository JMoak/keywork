import { type SessionTreeNode, textMessage } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { parseChord } from "./keys.ts";
import type { PaneIntents } from "./pane.ts";
import type { SessionTreeView } from "./session-tree-model.ts";
import { SessionTreePane, type SessionTreePort } from "./session-tree-pane.ts";
import type { SessionOverviewItem, SessionPresence } from "./sessions-overview-model.ts";

interface TreeWorld {
  items: SessionOverviewItem[];
  entriesBySession: Map<string, string[]>;
  overviewLoads: number;
  entryLoads: string[];
  attached: string[];
  forkedFrom: string[];
  unsubscribed: number;
  listeners: Array<(sessionId: string) => void>;
}

interface RecordedIntents {
  intents: PaneIntents;
  opened: string[];
  focused: string[];
}

function itemOf(id: string, modifiedAt = 0): SessionOverviewItem {
  return { id, title: `title-${id}`, modifiedAt, entryCount: 2, branchCount: 0, labelCount: 0 };
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
  };
}

function chainView(sessionId: string, entryIds: readonly string[]): SessionTreeView {
  return { sessionId, name: `name-${sessionId}`, roots: chainNodes(entryIds, null) };
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
      return entries === undefined ? undefined : chainView(sessionId, entries);
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
  };
  return port;
}

function recordedIntents(): RecordedIntents {
  const opened: string[] = [];
  const focused: string[] = [];
  return {
    opened,
    focused,
    intents: {
      openFile: () => {},
      openSession: (sessionId) => opened.push(sessionId),
      focusPane: (id) => focused.push(id),
    },
  };
}

interface PaneSetup {
  presence?: SessionPresence;
  sessionId?: string;
  forkResult?: () => Promise<string | undefined>;
  notify?: () => void;
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
      ...(setup.presence !== undefined && { presence: setup.presence }),
    },
  );
  return { pane, recorded, port };
}

function press(pane: SessionTreePane, ...specs: string[]): void {
  for (const spec of specs) pane.handleKey(parseChord(spec));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("SessionTreePane two levels", () => {
  it("opens at the overview listing every session, most recent first", async () => {
    const world = worldOf("s1", "s2");
    const { pane } = paneOver(world);
    await pane.settled();
    expect(pane.level()).toBe("overview");
    expect(pane.overview.rows().map((row) => row.id)).toEqual(["s1", "s2"]);
    expect(pane.title()).toBe(" session tree · 2 sessions ");
  });

  it("titles a lone session in the singular and stays plain when empty", async () => {
    const solo = paneOver(worldOf("s1")).pane;
    await solo.settled();
    expect(solo.title()).toBe(" session tree · 1 session ");
    const empty = paneOver(worldOf()).pane;
    await empty.settled();
    expect(empty.title()).toBe(" session tree ");
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

  it("drill-in and back preserves the overview cursor", async () => {
    const world = worldOf("s1", "s2", "s3");
    const { pane } = paneOver(world);
    await pane.settled();
    press(pane, "j", "j");
    expect(pane.overview.cursorRow()?.id).toBe("s3");
    press(pane, "l");
    await pane.settled();
    press(pane, "j", "backspace");
    await pane.settled();
    expect(pane.level()).toBe("overview");
    expect(pane.overview.cursorRow()?.id).toBe("s3");
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

  it("survives a port without overview or attach seams", async () => {
    const port: SessionTreePort = {
      load: async (sessionId) => chainView(sessionId, ["e1"]),
      setLabel: async () => {},
      fork: async () => undefined,
    };
    const recorded = recordedIntents();
    const pane = new SessionTreePane(
      "tree-1",
      () => {},
      recorded.intents,
      port,
      () => undefined,
    );
    await pane.settled();
    expect(pane.level()).toBe("overview");
    expect(pane.overview.rows()).toEqual([]);
    press(pane, "enter", "l");
    await pane.settled();
    expect(recorded.opened).toEqual([]);
  });
});

describe("SessionTreePane focus-or-open", () => {
  it("enter focuses the pane already showing the cursored session", async () => {
    const world = worldOf("s1", "s2");
    const presence: SessionPresence = {
      paneFor: (sessionId) => (sessionId === "s1" ? "session-9" : undefined),
      busy: () => false,
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
    const presence: SessionPresence = { paneFor: () => undefined, busy: () => false };
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
    };
    const { pane, recorded } = paneOver(world, { presence });
    await pane.settled();
    expect(pane.handleMouse({ x: 3, y: 2 }, { type: "down", x: 3, y: 2 })).toBe(true);
    await pane.settled();
    expect(pane.overview.cursor).toBe(1);
    expect(recorded.focused).toEqual(["session-7"]);
    expect(recorded.opened).toEqual([]);
  });

  it("a click below the listed sessions falls through", async () => {
    const world = worldOf("s1");
    const { pane, recorded } = paneOver(world);
    await pane.settled();
    expect(pane.handleMouse({ x: 3, y: 9 }, { type: "down", x: 3, y: 9 })).toBe(false);
    await pane.settled();
    expect(recorded.focused).toEqual([]);
    expect(recorded.opened).toEqual([]);
  });

  it("a click at the entries level selects that row without activating", async () => {
    const world = worldOf("s1");
    const { pane, recorded } = paneOver(world);
    await pane.settled();
    press(pane, "l");
    await pane.settled();
    expect(pane.level()).toBe("entries");
    expect(pane.handleMouse({ x: 3, y: 2 }, { type: "down", x: 3, y: 2 })).toBe(true);
    expect(pane.model.cursor).toBe(1);
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

describe("SessionTreePane entry-level effects", () => {
  it("opens the forked session once the fork lands", async () => {
    const world = worldOf("s1");
    const { pane, recorded } = paneOver(world);
    await pane.settled();
    press(pane, "l");
    await pane.settled();
    press(pane, "f");
    await pane.settled();
    expect(world.forkedFrom).toEqual(["s1-e1"]);
    expect(recorded.opened).toEqual(["forked-1"]);
  });

  it("a fork landing after dispose opens nothing and stays silent", async () => {
    const world = worldOf("s1");
    let release: (id: string) => void = () => {};
    let notified = 0;
    const { pane, recorded } = paneOver(world, {
      forkResult: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      notify: () => {
        notified += 1;
      },
    });
    await pane.settled();
    press(pane, "l");
    await pane.settled();
    press(pane, "f");
    pane.dispose();
    const notifiedBefore = notified;
    release("forked-1");
    await pane.settled();
    expect(recorded.opened).toEqual([]);
    expect(notified).toBe(notifiedBefore);
  });
});

describe("SessionTreePane push refresh", () => {
  it("a pushed change re-lists the overview within a frame, coalescing bursts", async () => {
    const world = worldOf("s1");
    const { pane } = paneOver(world);
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
    await sleep(40);
    await pane.settled();
    expect(world.overviewLoads).toBe(2);
    expect(pane.overview.rows().map((row) => row.id)).toEqual(["s2", "s1"]);
  });

  it("a pushed change refreshes the drilled entry tree, not the overview", async () => {
    const world = worldOf("s1");
    const { pane } = paneOver(world);
    await pane.settled();
    press(pane, "l");
    await pane.settled();
    expect(world.entryLoads).toEqual(["s1"]);

    world.entriesBySession.set("s1", ["s1-e1", "s1-e2", "s1-e3"]);
    for (const listener of world.listeners) listener("s1");
    await sleep(40);
    await pane.settled();
    expect(world.entryLoads).toEqual(["s1", "s1"]);
    expect(pane.model.entryCount()).toBe(3);
  });

  it("unsubscribes and cancels a pending refresh on dispose", async () => {
    const world = worldOf("s1");
    const { pane } = paneOver(world);
    await pane.settled();
    for (const listener of world.listeners) listener("s1");
    pane.dispose();
    await sleep(40);
    expect(world.unsubscribed).toBe(1);
    expect(world.overviewLoads).toBe(1);
  });

  it("starts no new work after dispose", async () => {
    const world = worldOf("s1");
    const { pane } = paneOver(world);
    await pane.settled();
    pane.dispose();
    pane.refresh();
    await pane.settled();
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
