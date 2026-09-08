import { describe, expect, it } from "vitest";
import type { ArcCloseOutcome, ArcSummary, ArcsPort } from "./arcs.ts";
import { ArcsPane, type ArcsPaneOptions } from "./arcs-pane.ts";
import type { FrameScheduler } from "./frame-scheduler.ts";
import type { PaneIntents } from "./pane.ts";
import type { SessionOverviewItem, SessionPresence } from "./sessions-overview-model.ts";
import { press } from "./testing/index.ts";
import { resolveTheme } from "./theme.ts";

const minute = 60_000;
const now = 60 * minute;

interface World {
  arcs: ArcSummary[];
  items: SessionOverviewItem[];
  lists: number;
  overviews: number;
  created: string[];
  closed: string[];
  abandoned: string[];
  attached: string[];
  attachResult: boolean;
  closeOutcome: ArcCloseOutcome;
  arcListeners: Array<() => void>;
  sessionListeners: Array<(sessionId: string) => void>;
  unsubscribed: number;
}

interface Recorded {
  intents: PaneIntents;
  opened: string[];
  focused: string[];
  notices: string[];
}

function arcOf(slug: string, status: ArcSummary["status"] = "active"): ArcSummary {
  return { slug, status, created: new Date(now - 50 * minute).toISOString(), sessions: 0 };
}

function itemOf(id: string, minutesAgo: number, arc?: string): SessionOverviewItem {
  return {
    id,
    title: `title-${id}`,
    createdAt: now - (minutesAgo + 1) * minute,
    modifiedAt: now - minutesAgo * minute,
    entryCount: 4,
    branchCount: 0,
    labelCount: 0,
    ...(arc !== undefined && { arc }),
  };
}

function worldOf(): World {
  return {
    arcs: [arcOf("dock-v2"), arcOf("infra"), arcOf("old-login", "archived")],
    items: [itemOf("s1", 5, "dock-v2"), itemOf("s2", 30, "dock-v2"), itemOf("s3", 9)],
    lists: 0,
    overviews: 0,
    created: [],
    closed: [],
    abandoned: [],
    attached: [],
    attachResult: true,
    closeOutcome: { kind: "closed", delivered: 2, released: 1 },
    arcListeners: [],
    sessionListeners: [],
    unsubscribed: 0,
  };
}

function portsOver(world: World): Pick<ArcsPaneOptions, "arcs" | "sessions"> {
  const arcs: ArcsPort = {
    list: async () => {
      world.lists += 1;
      return [...world.arcs];
    },
    create: async (slug) => {
      world.created.push(slug);
      const created = arcOf(slug);
      world.arcs = [...world.arcs, created];
      return created;
    },
    close: async (slug) => {
      world.closed.push(slug);
      return world.closeOutcome;
    },
    abandon: async (slug) => {
      world.abandoned.push(slug);
    },
    subscribe: (listener) => {
      world.arcListeners.push(listener);
      return () => {
        world.unsubscribed += 1;
      };
    },
  };
  return {
    arcs,
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
        world.sessionListeners.push(listener);
        return () => {
          world.unsubscribed += 1;
        };
      },
    },
  };
}

function recordedIntents(): Recorded {
  const opened: string[] = [];
  const focused: string[] = [];
  const notices: string[] = [];
  return {
    opened,
    focused,
    notices,
    intents: {
      openFile: () => {},
      openSession: (sessionId) => opened.push(sessionId),
      focusPane: (id) => focused.push(id),
      notice: (text) => notices.push(text),
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
  frames?: ManualFrames;
  drilled?: ArcsPaneOptions["drilled"];
  notify?: () => void;
}

function paneOver(world: World, setup: PaneSetup = {}) {
  const recorded = recordedIntents();
  const pane = new ArcsPane("arcs-1", setup.notify ?? (() => {}), recorded.intents, {
    ...portsOver(world),
    currentSession: () => "s1",
    now: () => now,
    arcOrdinal: (slug) => (slug === "dock-v2" ? 0 : undefined),
    ...(setup.presence !== undefined && { presence: setup.presence }),
    ...(setup.frames !== undefined && { scheduleFrame: setup.frames.scheduleFrame }),
    ...(setup.drilled !== undefined && { drilled: setup.drilled }),
  });
  return { pane, recorded };
}

function context() {
  return { theme: resolveTheme(), focused: true, width: 60, height: 12 };
}

function rendered(pane: ArcsPane): string {
  return JSON.stringify(describeTree(pane.view(context())));
}

function describeTree(node: unknown): { title?: unknown; content?: unknown; children?: unknown[] } {
  if (node === null || typeof node !== "object") return {};
  const record = node as { props?: { content?: unknown; title?: unknown }; children?: unknown[] };
  return {
    ...(record.props?.title !== undefined && { title: record.props.title }),
    ...(record.props?.content !== undefined && { content: record.props.content }),
    ...(Array.isArray(record.children) && { children: record.children.map(describeTree) }),
  };
}

describe("ArcsPane two levels", () => {
  it("loads arcs and sessions on construction and titles the arcs level by active count", async () => {
    const world = worldOf();
    const { pane } = paneOver(world);
    await pane.settled();
    expect(world.lists).toBe(1);
    expect(world.overviews).toBe(1);
    expect(pane.title()).toBe(" arcs · 2 arcs ");
    expect(pane.describe()).toEqual({ kind: "arcs" });
  });

  it("renders the arc groups and a drilled arc's sessions without the redundant tag", async () => {
    const world = worldOf();
    const { pane } = paneOver(world);
    await pane.settled();
    const arcsLevel = rendered(pane);
    expect(arcsLevel).toContain("░ dock-v2 · 2 sessions · 5m");
    expect(arcsLevel).toContain("no arc");
    expect(arcsLevel).toContain(" · 1 session · 9m");
    press(pane, "enter");
    await pane.settled();
    expect(pane.title()).toBe(" #dock-v2 · 2 sessions ");
    expect(pane.describe()).toEqual({ kind: "arcs", arc: "dock-v2" });
    const [body] = describeTree(pane.view(context())).children ?? [];
    const sessionsLevel = JSON.stringify(body);
    expect(sessionsLevel).toContain("title-s1");
    expect(sessionsLevel).not.toContain("#dock-v2");
    press(pane, "escape");
    expect(pane.title()).toBe(" arcs · 2 arcs ");
  });

  it("stays calm with no arcs and no sessions", async () => {
    const world = worldOf();
    world.arcs = [];
    world.items = [];
    const { pane } = paneOver(world);
    await pane.settled();
    expect(pane.title()).toBe(" arcs ");
    expect(rendered(pane)).toContain("no arcs yet");
  });

  it("revives drilled into an arc from its descriptor", async () => {
    const world = worldOf();
    const { pane } = paneOver(world, { drilled: { kind: "arc", slug: "dock-v2" } });
    await pane.settled();
    expect(pane.model.level()).toBe("sessions");
    expect(pane.model.sessions.sessionRows().map((row) => row.id)).toEqual(["s1", "s2"]);
  });
});

describe("ArcsPane mouse", () => {
  it("a click at the arcs level selects the row without drilling", async () => {
    const world = worldOf();
    const { pane } = paneOver(world);
    await pane.settled();
    rendered(pane);
    expect(pane.handleMouse({ x: 3, y: 2 }, { type: "down", x: 3, y: 2 })).toBe(true);
    expect(pane.model.level()).toBe("arcs");
    expect(pane.model.cursorRow()?.label).toBe("infra");
  });

  it("a click at the sessions level activates that session", async () => {
    const world = worldOf();
    const presence: SessionPresence = {
      paneFor: (sessionId) => (sessionId === "s2" ? "session-7" : undefined),
      busy: () => false,
      waiting: () => false,
    };
    const { pane, recorded } = paneOver(world, { presence });
    await pane.settled();
    press(pane, "enter");
    rendered(pane);
    expect(pane.handleMouse({ x: 3, y: 2 }, { type: "down", x: 3, y: 2 })).toBe(true);
    await pane.settled();
    expect(recorded.focused).toEqual(["session-7"]);
  });

  it("clicks below the rows or while failed fall through", async () => {
    const world = worldOf();
    const { pane } = paneOver(world);
    await pane.settled();
    expect(pane.handleMouse({ x: 3, y: 9 }, { type: "down", x: 3, y: 9 })).toBe(false);
    expect(pane.handleMouse({ x: 3, y: 2 }, { type: "move", x: 3, y: 2 })).toBe(false);
  });
});

describe("ArcsPane focus-or-open", () => {
  it("enter on a session focuses its open pane or attaches and opens it", async () => {
    const world = worldOf();
    const presence: SessionPresence = {
      paneFor: (sessionId) => (sessionId === "s1" ? "session-9" : undefined),
      busy: () => false,
      waiting: () => false,
    };
    const { pane, recorded } = paneOver(world, { presence });
    await pane.settled();
    press(pane, "enter", "enter");
    await pane.settled();
    expect(recorded.focused).toEqual(["session-9"]);
    press(pane, "j", "enter");
    await pane.settled();
    expect(world.attached).toEqual(["s2"]);
    expect(recorded.opened).toEqual(["s2"]);
  });

  it("opens nothing when the attach is refused", async () => {
    const world = worldOf();
    world.attachResult = false;
    const { pane, recorded } = paneOver(world);
    await pane.settled();
    press(pane, "enter", "enter");
    await pane.settled();
    expect(world.attached).toEqual(["s1"]);
    expect(recorded.opened).toEqual([]);
  });
});

describe("ArcsPane arc verbs", () => {
  it("n names an arc, creates it through the port, notices, and reloads", async () => {
    const world = worldOf();
    const { pane, recorded } = paneOver(world);
    await pane.settled();
    press(pane, "n");
    expect(rendered(pane)).toContain("new arc: ▌");
    for (const character of "checkout") press(pane, character);
    press(pane, "enter");
    await pane.settled();
    expect(world.created).toEqual(["checkout"]);
    expect(recorded.notices).toEqual(["arc checkout created · /arc checkout binds a session"]);
    expect(world.lists).toBe(2);
  });

  it("rejects a bad slug with a notice and creates nothing", async () => {
    const world = worldOf();
    const { pane, recorded } = paneOver(world);
    await pane.settled();
    press(pane, "n", "x", "space", "y", "enter");
    await pane.settled();
    expect(world.created).toEqual([]);
    expect(recorded.notices[0]).toContain("isn't an arc slug");
  });

  it("c closes and A abandons the cursored active arc with the airlock prose", async () => {
    const world = worldOf();
    const { pane, recorded } = paneOver(world);
    await pane.settled();
    press(pane, "c");
    await pane.settled();
    expect(world.closed).toEqual(["dock-v2"]);
    expect(recorded.notices).toEqual([
      "arc dock-v2 closed · delivered 2 notes · 1 session released",
    ]);
    world.closeOutcome = { kind: "pending", candidates: 1, questions: 2, wedged: 1 };
    press(pane, "j", "c", "shift+a");
    await pane.settled();
    expect(world.closed).toEqual(["dock-v2", "infra"]);
    expect(world.abandoned).toEqual(["infra"]);
    expect(recorded.notices[1]).toContain("arc infra is waiting at the airlock");
    expect(recorded.notices[2]).toBe(
      "arc infra abandoned · archived without distilling, nothing deleted",
    );
  });
});

describe("ArcsPane push refresh", () => {
  it("coalesces arc and session pushes into one reload per frame", async () => {
    const world = worldOf();
    const frames = manualFrames();
    const { pane } = paneOver(world, { frames });
    await pane.settled();
    for (const listener of world.arcListeners) listener();
    for (const listener of world.sessionListeners) listener("s1");
    expect(frames.pendingCount()).toBe(1);
    expect(world.lists).toBe(1);
    world.arcs = [...world.arcs, arcOf("fresh")];
    frames.runPending();
    await pane.settled();
    expect(world.lists).toBe(2);
    expect(pane.title()).toBe(" arcs · 3 arcs ");
  });

  it("unsubscribes both feeds and cancels the pending frame on dispose", async () => {
    const world = worldOf();
    const frames = manualFrames();
    const { pane } = paneOver(world, { frames });
    await pane.settled();
    for (const listener of world.arcListeners) listener();
    expect(frames.pendingCount()).toBe(1);
    pane.dispose();
    expect(frames.pendingCount()).toBe(0);
    expect(world.unsubscribed).toBe(2);
    frames.runPending();
    pane.refresh();
    await pane.settled();
    expect(world.lists).toBe(1);
  });

  it("a disposed pane stays silent when a verb lands late", async () => {
    const world = worldOf();
    let release: () => void = () => {};
    const ports = portsOver(world);
    ports.arcs.abandon = (slug) => {
      world.abandoned.push(slug);
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const recorded = recordedIntents();
    let notified = 0;
    const pane = new ArcsPane(
      "arcs-1",
      () => {
        notified += 1;
      },
      recorded.intents,
      { ...ports, currentSession: () => undefined, now: () => now },
    );
    await pane.settled();
    press(pane, "shift+a");
    expect(world.abandoned).toEqual(["dock-v2"]);
    pane.dispose();
    const notifiedBefore = notified;
    release();
    await pane.settled();
    expect(notified).toBe(notifiedBefore);
    expect(world.lists).toBe(1);
  });

  it("captures a load failure and recovers on the next refresh", async () => {
    const world = worldOf();
    const ports = portsOver(world);
    let fail = false;
    ports.arcs.list = async () => {
      world.lists += 1;
      if (fail) throw new Error("registry unreadable");
      return [...world.arcs];
    };
    const recorded = recordedIntents();
    const pane = new ArcsPane("arcs-1", () => {}, recorded.intents, {
      ...ports,
      currentSession: () => undefined,
      now: () => now,
    });
    await pane.settled();
    fail = true;
    press(pane, "r");
    await pane.settled();
    expect(rendered(pane)).toContain("registry unreadable");
    fail = false;
    press(pane, "r");
    await pane.settled();
    expect(rendered(pane)).not.toContain("registry unreadable");
  });
});

describe("ArcsPane command tray", () => {
  it("offers the arc verbs at the arcs level and runs them through the key path", async () => {
    const world = worldOf();
    const { pane } = paneOver(world);
    await pane.settled();
    press(pane, "/");
    expect(pane.tray.open).toBe(true);
    expect(pane.tray.matches().map((command) => command.name)).toEqual([
      "open",
      "new",
      "close",
      "abandon",
      "refresh",
    ]);
    expect(pane.tray.matches().map((command) => command.shortcut)).toEqual([
      "enter",
      "n",
      "c",
      "A",
      "r",
    ]);
    press(pane, "enter");
    await pane.settled();
    expect(pane.tray.open).toBe(false);
    expect(pane.model.level()).toBe("sessions");
    press(pane, "/");
    expect(pane.tray.matches().map((command) => command.name)).toEqual(["open", "back", "refresh"]);
  });

  it("never opens while an arc name is being typed", async () => {
    const world = worldOf();
    const { pane } = paneOver(world);
    await pane.settled();
    press(pane, "n", "/");
    expect(pane.tray.open).toBe(false);
    expect(pane.model.nameDraft).toBe("/");
  });
});
