import { describe, expect, it } from "vitest";
import { hourMs, minuteMs } from "../routines/clock.ts";
import { FakeClock } from "../routines/testing.ts";
import type { ShowEvents, ShowEventType } from "./setting.ts";
import { type SetOut, SettingStore, type ShowProposal, type ShowRefusal } from "./store.ts";

const t0 = Date.parse("2026-11-08T09:00:00Z");

interface Heard {
  sessionId: string;
  type: ShowEventType;
  payload: ShowEvents[ShowEventType];
}

function board(options: { hourlyLimit?: number } = {}) {
  const clock = new FakeClock(t0);
  const heard: Heard[] = [];
  const store = new SettingStore({
    clock,
    emit: (sessionId, type, payload) => heard.push({ sessionId, type, payload }),
    ...options,
  });
  const advanceTo = (at: number) => clock.advanceTo(at, async () => undefined);
  return { store, heard, advanceTo };
}

function proposal(overrides: Partial<ShowProposal> = {}): ShowProposal {
  return {
    creature: "wren",
    sessionId: "s1",
    what: { kind: "file", ref: "docs/plan.md", title: "The plan" },
    rung: "card",
    why: "The plan changed under the tests you asked about.",
    until: "seen",
    ...overrides,
  };
}

function setOut(outcome: SetOut | ShowRefusal): SetOut {
  if ("refused" in outcome) throw new Error(outcome.error);
  return outcome;
}

function settledOf(heard: readonly Heard[]) {
  return heard.filter(({ type }) => type === "show.settled").map(({ payload }) => payload);
}

describe("a setting the creature sets out", () => {
  it("is recorded live with the creature's thread and announced on that thread as show.proposed", () => {
    const { store, heard } = board();

    const { setting, replaced } = setOut(store.propose(proposal()));

    expect(setting).toEqual({
      id: expect.any(String),
      creature: "wren",
      sessionId: "s1",
      what: { kind: "file", ref: "docs/plan.md", title: "The plan" },
      rung: "card",
      why: "The plan changed under the tests you asked about.",
      at: "2026-11-08T09:00:00.000Z",
      until: "seen",
      state: "live",
    });
    expect(replaced).toBeUndefined();
    expect(store.open()).toEqual([setting]);
    expect(heard).toEqual([{ sessionId: "s1", type: "show.proposed", payload: { setting } }]);
  });

  it("replaces the creature's earlier setting of the same thing, withdrawing it first", () => {
    const { store, heard } = board();
    const first = setOut(store.propose(proposal())).setting;
    store.answer(first.id, "pinned");
    const other = setOut(store.propose(proposal({ creature: "hal" }))).setting;

    const second = setOut(
      store.propose(proposal({ sessionId: "s2", why: "It changed again.", rung: "unfold" })),
    );

    expect(second.replaced?.id).toBe(first.id);
    expect(store.open().map(({ id }) => id)).toEqual([other.id, second.setting.id]);
    expect(heard.slice(-2)).toEqual([
      {
        sessionId: "s1",
        type: "show.settled",
        payload: { id: first.id, outcome: "withdrawn", by: "creature" },
      },
      { sessionId: "s2", type: "show.proposed", payload: { setting: second.setting } },
    ]);
  });

  it("belongs to its thread when the session has no creature, so only that thread replaces it", () => {
    const { store, heard } = board();
    const first = setOut(store.propose(proposal({ creature: null }))).setting;
    setOut(store.propose(proposal({ creature: null, sessionId: "s2" })));
    setOut(store.propose(proposal()));

    const again = setOut(store.propose(proposal({ creature: null, why: "Changed again." })));

    expect(first.creature).toBeNull();
    expect(again.replaced?.id).toBe(first.id);
    expect(store.open().map(({ sessionId, creature }) => [sessionId, creature])).toEqual([
      ["s2", null],
      ["s1", "wren"],
      ["s1", null],
    ]);
    expect(settledOf(heard)).toEqual([{ id: first.id, outcome: "withdrawn", by: "creature" }]);
  });

  it("is a different setting when the same creature sets out a different thing", () => {
    const { store } = board();
    setOut(store.propose(proposal()));
    setOut(store.propose(proposal({ what: { kind: "diff", ref: "docs/plan.md" } })));
    setOut(store.propose(proposal({ what: { kind: "file", ref: "docs/other.md" } })));
    expect(store.open()).toHaveLength(3);
  });

  it("refuses an until that is not a time or has already passed", () => {
    const { store, heard } = board();
    expect(store.propose(proposal({ until: "tomorrow" }))).toEqual({
      refused: "invalid",
      error: "until is seen, rests or an ISO 8601 time, not tomorrow",
    });
    expect(store.propose(proposal({ until: "2026-11-08T08:59:00Z" }))).toEqual({
      refused: "invalid",
      error: "until 2026-11-08T08:59:00Z has already passed",
    });
    expect(heard).toEqual([]);
  });
});

describe("the keeper's answer", () => {
  it("settles a setting as seen or dismissed, and it leaves the yard", () => {
    const { store, heard } = board();
    const seen = setOut(store.propose(proposal())).setting;
    const dismissed = setOut(
      store.propose(proposal({ what: { kind: "note", ref: "Lunch is at noon." } })),
    ).setting;

    expect(store.answer(seen.id, "seen")).toEqual({ ...seen, state: "seen" });
    expect(store.answer(dismissed.id, "dismissed")).toEqual({ ...dismissed, state: "dismissed" });

    expect(store.open()).toEqual([]);
    expect(settledOf(heard)).toEqual([
      { id: seen.id, outcome: "seen", by: "keeper" },
      { id: dismissed.id, outcome: "dismissed", by: "keeper" },
    ]);
  });

  it("pins a setting so it stays out, and an unpin settles it as seen", () => {
    const { store, heard } = board();
    const { setting } = setOut(store.propose(proposal()));

    expect(store.answer(setting.id, "pinned")).toEqual({ ...setting, state: "pinned" });
    expect(store.open()).toEqual([{ ...setting, state: "pinned" }]);
    expect(store.answer(setting.id, "unpinned")).toEqual({ ...setting, state: "seen" });

    expect(store.open()).toEqual([]);
    expect(settledOf(heard)).toEqual([
      { id: setting.id, outcome: "pinned", by: "keeper" },
      { id: setting.id, outcome: "unpinned", by: "keeper" },
    ]);
  });

  it("refuses an answer that moves nothing, in words", () => {
    const { store, heard } = board();
    const { setting } = setOut(store.propose(proposal()));

    expect(store.answer("nope", "seen")).toEqual({
      refused: "missing",
      error: "no setting out has the id nope",
    });
    expect(store.answer(setting.id, "unpinned")).toEqual({
      refused: "conflict",
      error: `setting ${setting.id} is not pinned, so there is nothing to unpin`,
    });
    store.answer(setting.id, "pinned");
    expect(store.answer(setting.id, "seen")).toEqual({
      refused: "conflict",
      error: `setting ${setting.id} is pinned; unpin or dismiss it`,
    });
    store.answer(setting.id, "dismissed");
    expect(store.answer(setting.id, "seen")).toMatchObject({ refused: "missing" });
    expect(settledOf(heard)).toHaveLength(2);
  });
});

describe("the engine withdraws", () => {
  it("a thread's rests settings when that thread rests, and nothing else", () => {
    const { store, heard } = board();
    const rests = setOut(store.propose(proposal({ until: "rests" }))).setting;
    const pinned = setOut(
      store.propose(proposal({ until: "rests", what: { kind: "report", ref: "r1" } })),
    ).setting;
    store.answer(pinned.id, "pinned");
    const seen = setOut(store.propose(proposal({ what: { kind: "diff", ref: "c1" } }))).setting;
    const elsewhere = setOut(
      store.propose(proposal({ sessionId: "s2", until: "rests", what: { kind: "url", ref: "u" } })),
    ).setting;

    store.rested("s1");

    expect(store.open().map(({ id }) => id)).toEqual([pinned.id, seen.id, elsewhere.id]);
    expect(heard.at(-1)).toEqual({
      sessionId: "s1",
      type: "show.settled",
      payload: { id: rests.id, outcome: "withdrawn", by: "creature" },
    });
  });

  it("a timed setting at its time, through the clock", async () => {
    const { store, heard, advanceTo } = board();
    const timed = setOut(store.propose(proposal({ until: "2026-11-08T09:30:00-00:00" }))).setting;
    const answered = setOut(
      store.propose(proposal({ until: "2026-11-08T09:20:00Z", what: { kind: "chore", ref: "c" } })),
    ).setting;
    store.answer(answered.id, "seen");

    await advanceTo(t0 + 29 * minuteMs);
    expect(store.open().map(({ id }) => id)).toEqual([timed.id]);
    await advanceTo(t0 + 31 * minuteMs);

    expect(store.open()).toEqual([]);
    expect(settledOf(heard)).toEqual([
      { id: answered.id, outcome: "seen", by: "keeper" },
      { id: timed.id, outcome: "withdrawn", by: "time" },
    ]);
  });

  it("leaves a pinned setting out past its time, for the keeper to take in", async () => {
    const { store, advanceTo } = board();
    const { setting } = setOut(store.propose(proposal({ until: "2026-11-08T09:10:00Z" })));
    store.answer(setting.id, "pinned");
    await advanceTo(t0 + hourMs);
    expect(store.open()).toEqual([{ ...setting, state: "pinned" }]);
  });

  it("every live setting of a session that is removed, as the keeper's doing", () => {
    const { store, heard } = board();
    const seen = setOut(store.propose(proposal())).setting;
    const rests = setOut(
      store.propose(proposal({ until: "rests", what: { kind: "thread", ref: "s9" } })),
    ).setting;
    const elsewhere = setOut(
      store.propose(proposal({ sessionId: "s2", what: { kind: "note", ref: "hi" } })),
    ).setting;

    store.removed("s1");

    expect(store.open()).toEqual([elsewhere]);
    expect(settledOf(heard)).toEqual([
      { id: seen.id, outcome: "withdrawn", by: "keeper" },
      { id: rests.id, outcome: "withdrawn", by: "keeper" },
    ]);
  });

  it("nothing on a clock that was closed", async () => {
    const { store, heard, advanceTo } = board();
    setOut(store.propose(proposal({ until: "2026-11-08T09:10:00Z" })));
    store.close();
    await advanceTo(t0 + hourMs);
    expect(settledOf(heard)).toEqual([]);
  });
});

describe("the hourly limit", () => {
  it("refuses a creature's thirty-first setting in the hour in words, and lets it set out again an hour on", async () => {
    const { store, heard, advanceTo } = board();
    const note = (index: number) => ({ kind: "note" as const, ref: `note ${index}` });
    for (let index = 0; index < 30; index++) setOut(store.propose(proposal({ what: note(index) })));

    expect(store.propose(proposal({ what: note(30) }))).toEqual({
      refused: "limited",
      error:
        "wren has set out 30 settings this hour, the most a creature may set out; try again later",
    });
    setOut(store.propose(proposal({ creature: "hal", what: note(30) })));
    expect(heard.filter(({ type }) => type === "show.proposed")).toHaveLength(31);

    await advanceTo(t0 + hourMs + 1);
    setOut(store.propose(proposal({ what: note(31) })));
  });

  it("counts per thread for a session with no creature, and refuses in the thread's words", () => {
    const { store } = board({ hourlyLimit: 1 });
    setOut(store.propose(proposal({ creature: null })));

    expect(
      store.propose(proposal({ creature: null, what: { kind: "note", ref: "again" } })),
    ).toEqual({
      refused: "limited",
      error:
        "this thread has set out 1 settings this hour, the most a thread may set out; try again later",
    });
    setOut(store.propose(proposal({ creature: null, sessionId: "s2" })));
    setOut(store.propose(proposal()));
  });

  it("counts a replacement, since every call spends the keeper's attention", () => {
    const { store } = board({ hourlyLimit: 2 });
    setOut(store.propose(proposal()));
    setOut(store.propose(proposal()));
    expect(store.propose(proposal())).toMatchObject({ refused: "limited" });
    expect(store.open()).toHaveLength(1);
  });
});
