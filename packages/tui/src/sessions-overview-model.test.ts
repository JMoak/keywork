import { describe, expect, it } from "vitest";
import { parseChord } from "./keys.ts";
import {
  overviewRowLine,
  relativeAge,
  type SessionOverviewItem,
  type SessionOverviewRow,
  type SessionPresence,
  SessionsOverviewModel,
  type SessionsOverviewSeams,
} from "./sessions-overview-model.ts";
import { pressModel as press } from "./testing/index.ts";

interface Recorded {
  refreshes: number;
  activated: string[];
  drilled: string[];
}

function itemOf(id: string, modifiedAt: number, extra: Partial<SessionOverviewItem> = {}) {
  return {
    id,
    title: `title-${id}`,
    createdAt: modifiedAt,
    modifiedAt,
    entryCount: 4,
    branchCount: 1,
    labelCount: 0,
    ...extra,
  };
}

function modelOver(items: SessionOverviewItem[], seams: SessionsOverviewSeams = {}) {
  const recorded: Recorded = { refreshes: 0, activated: [], drilled: [] };
  const model = new SessionsOverviewModel(
    () => {},
    {
      refresh: () => {
        recorded.refreshes += 1;
      },
      activate: (sessionId) => recorded.activated.push(sessionId),
      drill: (sessionId) => recorded.drilled.push(sessionId),
    },
    { now: () => 10 * 60_000, ...seams },
  );
  model.setItems(items);
  return { model, recorded };
}

describe("SessionsOverviewModel rows", () => {
  it("sorts most-recent-first regardless of input order", () => {
    const { model } = modelOver([itemOf("old", 1), itemOf("new", 9 * 60_000), itemOf("mid", 5000)]);
    expect(model.sessionRows().map((row) => row.id)).toEqual(["new", "mid", "old"]);
  });

  it("derives liveness from presence: waiting over busy over attached over idle", () => {
    const presence: SessionPresence = {
      paneFor: (sessionId) => (sessionId === "gone" ? undefined : `pane-${sessionId}`),
      busy: (sessionId) => sessionId === "hot" || sessionId === "asking",
      waiting: (sessionId) => sessionId === "asking",
    };
    const { model } = modelOver(
      [itemOf("asking", 4), itemOf("hot", 3), itemOf("warm", 2), itemOf("gone", 1)],
      { presence },
    );
    expect(model.sessionRows().map((row) => row.liveness)).toEqual([
      "waiting",
      "busy",
      "attached",
      "idle",
    ]);
  });

  it("starts the cursor on the current session's row", () => {
    const { model } = modelOver([itemOf("a", 3), itemOf("b", 2), itemOf("c", 1)], {
      currentSession: () => "c",
    });
    expect(model.cursorSession()).toBe("c");
  });
});

describe("SessionsOverviewModel navigation and effects", () => {
  it("enter activates and l drills the cursored session", () => {
    const { model, recorded } = modelOver([itemOf("a", 2), itemOf("b", 1)]);
    press(model, "enter", "j", "l");
    expect(recorded.activated).toEqual(["a"]);
    expect(recorded.drilled).toEqual(["b"]);
  });
});

describe("SessionsOverviewModel grouping", () => {
  const minute = 60_000;
  const mixed = () => [
    itemOf("r1", 9 * minute, { bot: "reviewer", arc: "dock-v2" }),
    itemOf("free", 8 * minute),
    itemOf("s1", 7 * minute, { bot: "scout", arc: "auth" }),
    itemOf("r2", 6 * minute, { bot: "reviewer" }),
    itemOf("a1", 5 * minute, { arc: "auth" }),
  ];

  function lines(model: SessionsOverviewModel): string[] {
    return model.rows().map((row) => overviewRowLine(row, false));
  }

  it("starts ungrouped and g walks none · arc · bot · none", () => {
    const { model } = modelOver(mixed());
    expect(model.groupBy()).toBe("none");
    press(model, "g");
    expect(model.groupBy()).toBe("arc");
    press(model, "g");
    expect(model.groupBy()).toBe("bot");
    press(model, "g");
    expect(model.groupBy()).toBe("none");
    expect(model.rows().every((row) => row.kind === "session")).toBe(true);
  });

  it("groups by bot with sigil-led headers, groups by their newest session, unbound last", () => {
    const { model } = modelOver(mixed(), {
      groupBy: "bot",
      botSigil: (name) => (name === "reviewer" ? "⚖" : undefined),
    });
    expect(lines(model)).toEqual([
      "⚖ reviewer · 2 sessions · 1m",
      "░ title-r1 · 1m #dock-v2",
      "░ title-r2 · 4m",
      "S scout · 1 session · 3m",
      "░ title-s1 · 3m #auth",
      "no bot · 2 sessions · 2m",
      "░ title-free · 2m",
      "░ title-a1 · 5m #auth",
    ]);
  });

  it("never parks the cursor on a header and skips headers while moving", () => {
    const { model } = modelOver(mixed(), { groupBy: "bot" });
    expect(model.cursorSession()).toBe("r1");
    press(model, "j", "j");
    expect(model.cursorSession()).toBe("s1");
    press(model, "k", "k", "k");
    expect(model.cursorSession()).toBe("r1");
    expect(model.visibleRows(8).filter((row) => row.selected)).toHaveLength(1);
  });

  it("keeps the cursored session when the grouping changes or the list refreshes", () => {
    const { model } = modelOver(mixed());
    press(model, "j", "j");
    expect(model.cursorSession()).toBe("s1");
    press(model, "g");
    expect(model.cursorSession()).toBe("s1");
    press(model, "g");
    expect(model.cursorSession()).toBe("s1");
    model.setItems([...mixed()].reverse());
    expect(model.groupBy()).toBe("bot");
    expect(model.cursorSession()).toBe("s1");
  });
});

describe("overview row rendering", () => {
  const row: SessionOverviewRow = {
    kind: "session",
    id: "s1",
    title: "plan the fix",
    age: "3m",
    liveness: "attached",
    arc: undefined,
    bot: undefined,
    current: false,
    entryCount: 7,
    branchCount: 2,
    labelCount: 1,
    cost: undefined,
  };

  it("collapsed rows stay minimal: mark, title, age", () => {
    expect(overviewRowLine(row, false)).toBe("▓ plan the fix · 3m");
  });

  it("an unknown cost stays off the row instead of showing as free", () => {
    expect(overviewRowLine(row, true)).toBe("▓ plan the fix · 3m · 7e 2b 1l");
    expect(overviewRowLine({ ...row, cost: "$0.0042" }, false)).toBe("▓ plan the fix · 3m");
  });
});

describe("overview cost formatting", () => {
  it("formats a known session cost into the row model", () => {
    const { model } = modelOver([itemOf("a", 1, { costNanos: 4_200_000 })]);
    expect(model.sessionRows()[0]?.cost).toBe("$0.0042");
  });
});

describe("relativeAge", () => {
  it("steps through now, minutes, hours, days, weeks", () => {
    const now = Date.UTC(2026, 7, 16, 12, 0, 0);
    expect(relativeAge(now, now - 20_000)).toBe("now");
    expect(relativeAge(now, now - 3 * 60_000)).toBe("3m");
    expect(relativeAge(now, now - 5 * 3_600_000)).toBe("5h");
    expect(relativeAge(now, now - 2 * 86_400_000)).toBe("2d");
    expect(relativeAge(now, now - 21 * 86_400_000)).toBe("3w");
    expect(relativeAge(now, now + 60_000)).toBe("now");
  });
});

describe("SessionsOverviewModel removal", () => {
  function removable(items: SessionOverviewItem[]) {
    const removed: Array<[string, string]> = [];
    const model = new SessionsOverviewModel(
      () => {},
      {
        refresh: () => {},
        activate: () => {},
        drill: () => {},
        remove: (sessionId, title) => removed.push([sessionId, title]),
      },
      { now: () => 10 * 60_000 },
    );
    model.setItems(items);
    return { model, removed };
  }

  it("x asks about the cursored session and enter confirms", () => {
    const { model, removed } = removable([itemOf("a", 2), itemOf("b", 1)]);
    expect(model.handleKey(parseChord("x"), 20)).toBe(true);
    expect(model.removal()).toEqual({ sessionId: "a", title: "title-a" });
    expect(model.removalPrompt()).toBe(
      'remove "title-a"? enter trashes it, memory notes stay · any other key cancels',
    );
    expect(model.handleKey(parseChord("enter"), 20)).toBe(true);
    expect(removed).toEqual([["a", "title-a"]]);
    expect(model.removal()).toBeUndefined();
  });

  it("any other key cancels without moving the cursor or removing", () => {
    const { model, removed } = removable([itemOf("a", 2), itemOf("b", 1)]);
    press(model, "x", "j");
    expect(model.removal()).toBeUndefined();
    expect(model.cursorSession()).toBe("a");
    expect(removed).toEqual([]);
  });
});
