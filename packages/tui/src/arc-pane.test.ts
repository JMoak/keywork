import { describe, expect, it } from "vitest";
import { ArcPane, type ArcPaneOptions, memberRowLine } from "./arc-pane.ts";
import { parseChord } from "./keys.ts";
import type { PaneIntents } from "./pane.ts";
import type { PointerEvent } from "./pointer.ts";
import type { SessionOverviewItem, SessionPresence } from "./sessions-overview-model.ts";
import { resolveTheme } from "./theme.ts";

const minute = 60_000;
const now = 120 * minute;

interface World {
  items: SessionOverviewItem[];
  overviews: number;
  attached: string[];
  attachResult: boolean;
  listeners: Array<(sessionId: string) => void>;
  unsubscribed: number;
}

interface Recorded {
  intents: PaneIntents;
  opened: string[];
  focused: string[];
  held: Set<string>;
  shows: Array<[string, readonly string[] | undefined]>;
  notices: string[];
}

function itemOf(id: string, createdMinutesAgo: number, arc?: string): SessionOverviewItem {
  return {
    id,
    title: `title-${id}`,
    createdAt: now - createdMinutesAgo * minute,
    modifiedAt: now - minute,
    entryCount: 3,
    branchCount: 0,
    labelCount: 0,
    ...(arc !== undefined && { arc }),
  };
}

function worldOf(): World {
  return {
    items: [
      itemOf("newest", 2, "dock-v2"),
      itemOf("oldest", 40, "dock-v2"),
      itemOf("middle", 10, "dock-v2"),
      itemOf("elsewhere", 5, "infra"),
      itemOf("unbound", 1),
    ],
    overviews: 0,
    attached: [],
    attachResult: true,
    listeners: [],
    unsubscribed: 0,
  };
}

function recordedIntents(): Recorded {
  const opened: string[] = [];
  const focused: string[] = [];
  const held = new Set<string>();
  const shows: Recorded["shows"] = [];
  const notices: string[] = [];
  return {
    opened,
    focused,
    held,
    shows,
    notices,
    intents: {
      openFile: () => {},
      openSession: (sessionId) => opened.push(sessionId),
      focusPane: (id) => focused.push(id),
      notice: (text) => notices.push(text),
      holdPane: (id) => {
        held.add(id);
        return true;
      },
      showPane: (id, near) => {
        held.delete(id);
        shows.push([id, near]);
        return true;
      },
      paneHeld: (id) => held.has(id),
    },
  };
}

function presenceOf(
  paneFor: (sessionId: string) => string | undefined,
  activity: Partial<Pick<SessionPresence, "busy" | "waiting">> = {},
): SessionPresence {
  return { paneFor, busy: () => false, waiting: () => false, ...activity };
}

const membersOpen = presenceOf((sessionId) =>
  sessionId === "unbound" ? undefined : `pane-${sessionId}`,
);

function paneOver(world: World, presence?: SessionPresence, extra: Partial<ArcPaneOptions> = {}) {
  const recorded = recordedIntents();
  const options: ArcPaneOptions = {
    ...extra,
    slug: "dock-v2",
    sessions: {
      overview: async () => {
        world.overviews += 1;
        return [...world.items];
      },
      attach: async (sessionId) => {
        world.attached.push(sessionId);
        return world.attachResult;
      },
      subscribe: (listener) => {
        world.listeners.push(listener);
        return () => {
          world.unsubscribed += 1;
        };
      },
    },
    currentSession: () => "middle",
    now: () => now,
    scheduleFrame: (run) => {
      run();
      return () => {};
    },
    ...(presence !== undefined && { presence }),
  };
  const pane = new ArcPane("arc-1", () => {}, recorded.intents, options);
  return { pane, recorded };
}

function press(pane: ArcPane, ...specs: string[]): void {
  for (const spec of specs) pane.handleKey(parseChord(spec), spec.length === 1 ? spec : undefined);
}

function rowLines(pane: ArcPane): string[] {
  return pane.members
    .visibleRows(20)
    .map(({ row }) => memberRowLine(row, pane.placementOf(row.id)));
}

describe("ArcPane", () => {
  it("lists the arc's members in creation order with a state word and age, titled by the arc", async () => {
    const world = worldOf();
    const { pane } = paneOver(world);
    await pane.settled();
    expect(pane.title()).toBe(" #dock-v2 · 3 sessions ");
    expect(rowLines(pane)).toEqual([
      "░ title-oldest · closed · 1m",
      "░ title-middle · closed · 1m",
      "░ title-newest · closed · 1m",
    ]);
    expect(pane.describe()).toEqual({ kind: "arc", arc: "dock-v2" });
  });

  it("reads liveness from presence: working while busy, idle while merely open", async () => {
    const world = worldOf();
    const { pane } = paneOver(
      world,
      presenceOf((sessionId) => (sessionId === "unbound" ? undefined : `pane-${sessionId}`), {
        busy: (sessionId) => sessionId === "oldest",
      }),
    );
    await pane.settled();
    expect(rowLines(pane)).toEqual([
      "█ title-oldest · working · 1m",
      "▓ title-middle · idle · 1m",
      "▓ title-newest · idle · 1m",
    ]);
  });

  it("enter focuses an open member's pane and opens a closed one after attaching", async () => {
    const world = worldOf();
    const { pane, recorded } = paneOver(
      world,
      presenceOf((sessionId) => (sessionId === "middle" ? "session-7" : undefined)),
    );
    await pane.settled();
    press(pane, "enter");
    await pane.settled();
    expect(recorded.focused).toEqual(["session-7"]);
    press(pane, "down", "enter");
    await pane.settled();
    expect(world.attached).toEqual(["newest"]);
    expect(recorded.opened).toEqual(["newest"]);
  });

  it("stays an arc pane: escape is not a way out, and the tray offers open and refresh", async () => {
    const world = worldOf();
    const { pane } = paneOver(world);
    await pane.settled();
    expect(pane.handleKey(parseChord("escape"))).toBe(false);
    expect(pane.title()).toBe(" #dock-v2 · 3 sessions ");
    press(pane, "/");
    expect(pane.tray.open).toBe(true);
  });

  it("refreshes when the session feed changes and lets go on dispose", async () => {
    const world = worldOf();
    const { pane } = paneOver(world);
    await pane.settled();
    const before = world.overviews;
    world.items = world.items.filter((item) => item.id !== "middle");
    for (const listener of world.listeners) listener("middle");
    await pane.settled();
    expect(world.overviews).toBe(before + 1);
    expect(pane.title()).toBe(" #dock-v2 · 2 sessions ");
    pane.dispose();
    expect(world.unsubscribed).toBe(1);
  });

  it("titles an empty arc by name alone and still renders", async () => {
    const world = worldOf();
    world.items = [];
    const { pane } = paneOver(world);
    await pane.settled();
    expect(pane.title()).toBe(" #dock-v2 ");
    expect(rowLines(pane)).toEqual([]);
    expect(() =>
      pane.view({ theme: resolveTheme(), focused: true, width: 60, height: 8 }),
    ).not.toThrow();
  });
});

describe("ArcPane return delta", () => {
  const down: PointerEvent = { type: "down", x: 0, y: 0, button: 0 };

  it("shows the quiet digest above the members and offsets clicks past it", async () => {
    const world = worldOf();
    const { pane, recorded } = paneOver(world, membersOpen, {
      returnDelta: async () => ["2 new in #dock-v2: [[A]], [[B]]"],
    });
    await pane.settled();
    expect(() =>
      pane.view({ theme: resolveTheme(), focused: true, width: 60, height: 10 }),
    ).not.toThrow();
    expect(pane.handleMouse({ x: 2, y: 1 }, down)).toBe(false);
    expect(pane.handleMouse({ x: 2, y: 2 }, down)).toBe(true);
    expect(recorded.focused).toEqual(["pane-oldest"]);
  });

  it("caps the digest at three lines", async () => {
    const world = worldOf();
    const { pane } = paneOver(world, membersOpen, {
      returnDelta: async () => ["one", "two", "three", "four", "five"],
    });
    await pane.settled();
    expect(pane.handleMouse({ x: 2, y: 3 }, down)).toBe(false);
    expect(pane.handleMouse({ x: 2, y: 4 }, down)).toBe(true);
  });

  it("renders nothing and shifts nothing when the delta is empty or fails", async () => {
    const world = worldOf();
    const quiet = paneOver(world, membersOpen, { returnDelta: async () => [] });
    await quiet.pane.settled();
    expect(quiet.pane.handleMouse({ x: 2, y: 1 }, down)).toBe(true);

    const failing = paneOver(world, membersOpen, {
      returnDelta: async () => {
        throw new Error("vault offline");
      },
    });
    await failing.pane.settled();
    expect(rowLines(failing.pane)).toHaveLength(3);
    expect(failing.pane.handleMouse({ x: 2, y: 1 }, down)).toBe(true);
  });
});

describe("ArcPane folds", () => {
  it("space folds the selected member's pane and unfolds it beside the arc's cluster", async () => {
    const world = worldOf();
    const { pane, recorded } = paneOver(world, membersOpen);
    await pane.settled();
    press(pane, "space");
    expect([...recorded.held]).toEqual(["pane-middle"]);
    expect(rowLines(pane)[1]).toBe("░ title-middle · folded · 1m");
    expect(pane.title()).toBe(" #dock-v2 · 3 sessions · 1 folded ");
    press(pane, "space");
    expect(recorded.held.size).toBe(0);
    expect(recorded.shows).toEqual([
      ["pane-middle", ["pane-oldest", "pane-middle", "pane-newest", "arc-1"]],
    ]);
    expect(rowLines(pane)[1]).toBe("▓ title-middle · idle · 1m");
    expect(pane.title()).toBe(" #dock-v2 · 3 sessions ");
  });

  it("a folds every shown member while any is shown, then unfolds them all", async () => {
    const world = worldOf();
    const { pane, recorded } = paneOver(world, membersOpen);
    await pane.settled();
    press(pane, "space", "a");
    expect([...recorded.held].sort()).toEqual(["pane-middle", "pane-newest", "pane-oldest"]);
    expect(pane.title()).toBe(" #dock-v2 · 3 sessions · 3 folded ");
    press(pane, "a");
    expect(recorded.held.size).toBe(0);
    expect(recorded.shows.map(([id]) => id)).toEqual(["pane-oldest", "pane-middle", "pane-newest"]);
  });

  it("a folded member that needs you keeps a full stamp and the arc pane wears it too", async () => {
    const world = worldOf();
    const { pane, recorded } = paneOver(
      world,
      presenceOf((sessionId) => (sessionId === "unbound" ? undefined : `pane-${sessionId}`), {
        busy: (sessionId) => sessionId === "middle",
        waiting: (sessionId) => sessionId === "middle",
      }),
    );
    await pane.settled();
    expect(rowLines(pane)[1]).toBe("█ title-middle · needs you · 1m");
    expect(pane.title()).toBe(" #dock-v2 · 3 sessions ");
    press(pane, "space");
    expect(recorded.held.has("pane-middle")).toBe(true);
    expect(rowLines(pane)[1]).toBe("█ title-middle · needs you · 1m");
    expect(pane.title()).toBe(" █ #dock-v2 · 3 sessions · 1 folded ");
  });

  it("enter on a folded member unfolds it first and then focuses its pane", async () => {
    const world = worldOf();
    const { pane, recorded } = paneOver(world, membersOpen);
    await pane.settled();
    press(pane, "space");
    expect(recorded.held.has("pane-middle")).toBe(true);
    press(pane, "enter");
    await pane.settled();
    expect(recorded.held.size).toBe(0);
    expect(recorded.shows.map(([id]) => id)).toEqual(["pane-middle"]);
    expect(recorded.focused).toEqual(["pane-middle"]);
  });

  it("space on a closed member only explains itself", async () => {
    const world = worldOf();
    const { pane, recorded } = paneOver(world);
    await pane.settled();
    press(pane, "space");
    expect(recorded.held.size).toBe(0);
    expect(recorded.notices).toEqual(["closed session · enter opens it"]);
  });
});
