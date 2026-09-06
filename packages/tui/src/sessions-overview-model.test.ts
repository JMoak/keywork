import { describe, expect, it } from "vitest";
import { parseChord } from "./keys.ts";
import {
  groupByHint,
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

  it("everything is idle without a presence seam", () => {
    const { model } = modelOver([itemOf("a", 1)]);
    expect(model.sessionRows()[0]?.liveness).toBe("idle");
  });

  it("marks the current session's row and carries the arc and bot seams through", () => {
    const { model } = modelOver(
      [itemOf("a", 2, { arc: "auth-fix", bot: "reviewer" }), itemOf("b", 1)],
      { currentSession: () => "b" },
    );
    expect(model.sessionRows().map((row) => [row.current, row.arc, row.bot])).toEqual([
      [false, "auth-fix", "reviewer"],
      [true, undefined, undefined],
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
  it("moves with j/k and clamps at the edges", () => {
    const { model } = modelOver([itemOf("a", 3), itemOf("b", 2), itemOf("c", 1)]);
    press(model, "k");
    expect(model.cursor).toBe(0);
    press(model, "j", "j", "j", "j");
    expect(model.cursor).toBe(2);
    press(model, "pageup");
    expect(model.cursor).toBe(0);
  });

  it("enter activates and l drills the cursored session", () => {
    const { model, recorded } = modelOver([itemOf("a", 2), itemOf("b", 1)]);
    press(model, "enter", "j", "l");
    expect(recorded.activated).toEqual(["a"]);
    expect(recorded.drilled).toEqual(["b"]);
  });

  it("r asks for a refresh and unknown keys fall through", () => {
    const { model, recorded } = modelOver([itemOf("a", 1)]);
    press(model, "r");
    expect(recorded.refreshes).toBe(1);
    expect(model.handleKey(parseChord("h"), 5)).toBe(false);
  });

  it("activate and drill stay silent on an empty overview", () => {
    const { model, recorded } = modelOver([]);
    press(model, "enter", "l", "j", "k");
    expect(recorded.activated).toEqual([]);
    expect(recorded.drilled).toEqual([]);
    expect(model.rows()).toEqual([]);
    expect(model.cursorRow()).toBeUndefined();
  });

  it("windowed rendering keeps the cursor inside the viewport", () => {
    const items = Array.from({ length: 10 }, (_, at) => itemOf(`s${at}`, 100 - at));
    const { model } = modelOver(items);
    press(model, "pagedown", "pagedown");
    const visible = model.visibleRows(3);
    expect(visible).toHaveLength(3);
    expect(visible.some(({ index }) => index === model.cursor)).toBe(true);
  });
});

describe("SessionsOverviewModel refresh survival", () => {
  it("keeps the cursor on the same session when the list reorders", () => {
    const { model } = modelOver([itemOf("a", 3), itemOf("b", 2), itemOf("c", 1)]);
    press(model, "j");
    expect(model.cursorSession()).toBe("b");
    model.setItems([itemOf("a", 3), itemOf("b", 9), itemOf("fresh", 5), itemOf("c", 1)]);
    expect(model.cursorSession()).toBe("b");
    expect(model.cursor).toBe(0);
  });

  it("clamps to the nearest surviving row when the cursored session vanishes", () => {
    const { model } = modelOver([itemOf("a", 3), itemOf("b", 2), itemOf("c", 1)]);
    press(model, "pagedown");
    expect(model.cursorSession()).toBe("c");
    model.setItems([itemOf("a", 3)]);
    expect(model.cursorSession()).toBe("a");
  });

  it("survives the list emptying and repopulating", () => {
    const { model } = modelOver([itemOf("a", 1)]);
    model.setItems([]);
    expect(model.cursorRow()).toBeUndefined();
    model.setItems([itemOf("solo", 1)]);
    expect(model.cursorSession()).toBe("solo");
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

  it("groups by arc under the arc tag, most recent group first", () => {
    const { model } = modelOver(mixed(), { groupBy: "arc" });
    expect(lines(model)).toEqual([
      "#dock-v2 · 1 session · 1m",
      "░ title-r1 · 1m #dock-v2",
      "#auth · 2 sessions · 3m",
      "░ title-s1 · 3m #auth",
      "░ title-a1 · 5m #auth",
      "no arc · 2 sessions · 2m",
      "░ title-free · 2m",
      "░ title-r2 · 4m",
    ]);
  });

  it("shows no lone unbound header when nothing on the axis is bound", () => {
    const { model } = modelOver([itemOf("a", 2, { arc: "auth" }), itemOf("b", 1)], {
      groupBy: "bot",
    });
    expect(model.rows().map((row) => row.kind)).toEqual(["session", "session"]);
    expect(model.groupBy()).toBe("bot");
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

  it("enter and l act on the cursored session inside a group", () => {
    const { model, recorded } = modelOver(mixed(), { groupBy: "bot" });
    press(model, "j", "enter", "l");
    expect(recorded.activated).toEqual(["r2"]);
    expect(recorded.drilled).toEqual(["r2"]);
  });

  it("clicking a header row selects nothing and activates nothing", () => {
    const { model, recorded } = modelOver(mixed(), { groupBy: "bot" });
    expect(model.activateVisible(0, 8)).toBe(true);
    expect(recorded.activated).toEqual([]);
    expect(model.activateVisible(1, 8)).toBe(true);
    expect(recorded.activated).toEqual(["r1"]);
  });

  it("falls back to the slug's first letter when a bot is no longer defined", () => {
    const { model } = modelOver([itemOf("x", 1, { bot: "gone-bot" })], { groupBy: "bot" });
    expect(lines(model)[0]).toBe("G gone-bot · 1 session · 9m");
  });

  it("names the key in the hint for every state", () => {
    expect(groupByHint("none")).toBe("g · group by arc or bot");
    expect(groupByHint("arc")).toBe("g · grouped by arc");
    expect(groupByHint("bot")).toBe("g · grouped by bot");
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

  it("counts appear only on the cursored row", () => {
    expect(overviewRowLine(row, true)).toBe("▓ plan the fix · 3m · 7e 2b 1l");
    expect(overviewRowLine({ ...row, branchCount: 0, labelCount: 0 }, true)).toBe(
      "▓ plan the fix · 3m · 7e",
    );
  });

  it("speaks the density ramp for liveness", () => {
    expect(overviewRowLine({ ...row, liveness: "busy" }, false).startsWith("█")).toBe(true);
    expect(overviewRowLine({ ...row, liveness: "idle" }, false).startsWith("░")).toBe(true);
  });

  it("renders the arc slug tag when the seam is populated", () => {
    expect(overviewRowLine({ ...row, arc: "auth-fix" }, false)).toBe(
      "▓ plan the fix · 3m #auth-fix",
    );
  });

  it("the cursored row gains the session's cost when it is known", () => {
    expect(overviewRowLine({ ...row, cost: "$0.0042" }, true)).toBe(
      "▓ plan the fix · 3m · 7e 2b 1l $0.0042",
    );
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

  it("leaves cost undefined when the item carries none", () => {
    const { model } = modelOver([itemOf("a", 1)]);
    expect(model.sessionRows()[0]?.cost).toBeUndefined();
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
