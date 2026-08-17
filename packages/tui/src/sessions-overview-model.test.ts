import { describe, expect, it } from "vitest";
import { parseChord } from "./keys.ts";
import {
  overviewRowLine,
  relativeAge,
  type SessionOverviewItem,
  type SessionOverviewRow,
  type SessionPresence,
  SessionsOverviewModel,
} from "./sessions-overview-model.ts";

interface Recorded {
  refreshes: number;
  activated: string[];
  drilled: string[];
}

function itemOf(id: string, modifiedAt: number, extra: Partial<SessionOverviewItem> = {}) {
  return {
    id,
    title: `title-${id}`,
    modifiedAt,
    entryCount: 4,
    branchCount: 1,
    labelCount: 0,
    ...extra,
  };
}

function modelOver(
  items: SessionOverviewItem[],
  seams: { presence?: SessionPresence; currentSession?: () => string | undefined } = {},
) {
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
    { ...seams, now: () => 10 * 60_000 },
  );
  model.setItems(items);
  return { model, recorded };
}

function press(model: SessionsOverviewModel, ...specs: string[]): void {
  for (const spec of specs) model.handleKey(parseChord(spec), 5);
}

describe("SessionsOverviewModel rows", () => {
  it("sorts most-recent-first regardless of input order", () => {
    const { model } = modelOver([itemOf("old", 1), itemOf("new", 9 * 60_000), itemOf("mid", 5000)]);
    expect(model.rows().map((row) => row.id)).toEqual(["new", "mid", "old"]);
  });

  it("derives liveness from presence: busy over attached over idle", () => {
    const presence: SessionPresence = {
      paneFor: (sessionId) => (sessionId === "gone" ? undefined : `pane-${sessionId}`),
      busy: (sessionId) => sessionId === "hot",
    };
    const { model } = modelOver([itemOf("hot", 3), itemOf("warm", 2), itemOf("gone", 1)], {
      presence,
    });
    expect(model.rows().map((row) => row.liveness)).toEqual(["busy", "attached", "idle"]);
  });

  it("everything is idle without a presence seam", () => {
    const { model } = modelOver([itemOf("a", 1)]);
    expect(model.rows()[0]?.liveness).toBe("idle");
  });

  it("marks the current session's row and carries the arc seam through", () => {
    const { model } = modelOver([itemOf("a", 2, { arc: "auth-fix" }), itemOf("b", 1)], {
      currentSession: () => "b",
    });
    expect(model.rows().map((row) => [row.current, row.arc])).toEqual([
      [false, "auth-fix"],
      [true, undefined],
    ]);
  });

  it("starts the cursor on the current session's row", () => {
    const { model } = modelOver([itemOf("a", 3), itemOf("b", 2), itemOf("c", 1)], {
      currentSession: () => "c",
    });
    expect(model.cursorRow()?.id).toBe("c");
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
    expect(model.cursorRow()?.id).toBe("b");
    model.setItems([itemOf("a", 3), itemOf("b", 9), itemOf("fresh", 5), itemOf("c", 1)]);
    expect(model.cursorRow()?.id).toBe("b");
    expect(model.cursor).toBe(0);
  });

  it("clamps to the nearest surviving row when the cursored session vanishes", () => {
    const { model } = modelOver([itemOf("a", 3), itemOf("b", 2), itemOf("c", 1)]);
    press(model, "pagedown");
    expect(model.cursorRow()?.id).toBe("c");
    model.setItems([itemOf("a", 3)]);
    expect(model.cursorRow()?.id).toBe("a");
  });

  it("survives the list emptying and repopulating", () => {
    const { model } = modelOver([itemOf("a", 1)]);
    model.setItems([]);
    expect(model.cursorRow()).toBeUndefined();
    model.setItems([itemOf("solo", 1)]);
    expect(model.cursorRow()?.id).toBe("solo");
  });
});

describe("overview row rendering", () => {
  const row: SessionOverviewRow = {
    id: "s1",
    title: "plan the fix",
    age: "3m",
    liveness: "attached",
    arc: undefined,
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
    expect(model.rows()[0]?.cost).toBe("$0.0042");
  });

  it("leaves cost undefined when the item carries none", () => {
    const { model } = modelOver([itemOf("a", 1)]);
    expect(model.rows()[0]?.cost).toBeUndefined();
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
