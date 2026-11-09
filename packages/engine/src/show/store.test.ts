import { describe, expect, it } from "vitest";
import { hourMs, minuteMs } from "../routines/clock.ts";
import { FakeClock } from "../routines/testing.ts";
import { memorySettingStorage } from "./kept.ts";
import type { ShowThread } from "./lineage.ts";
import type { Setting, ShowEvents, ShowEventType } from "./setting.ts";
import {
  type SetOut,
  SettingStore,
  type SettingStoreOptions,
  type ShowProposal,
  type ShowRefusal,
} from "./store.ts";

const t0 = Date.parse("2026-11-08T09:00:00Z");

interface Heard {
  sessionId: string;
  type: ShowEventType;
  payload: ShowEvents[ShowEventType];
}

function board(options: Pick<SettingStoreOptions, "hourlyLimit" | "threads"> = {}) {
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
    from: null,
    origin: "creature",
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
      from: null,
      origin: "creature",
      replaces: null,
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

describe("a setting's size", () => {
  it("is carried on the record and on show.proposed when named, and absent when not", () => {
    const { store, heard } = board();

    const named = setOut(store.propose(proposal({ size: "working" }))).setting;
    const unnamed = setOut(store.propose(proposal({ what: { kind: "note", ref: "n" } }))).setting;

    expect(named.size).toBe("working");
    expect(unnamed).not.toHaveProperty("size");
    expect(heard[0]?.payload).toEqual({ setting: named });
  });

  it("is kept by a replacement that names no size, and replaced by one that does", () => {
    const { store } = board();
    setOut(store.propose(proposal({ size: "working" })));

    const kept = setOut(store.propose(proposal({ why: "It moved." }))).setting;
    const changed = setOut(
      store.propose(proposal({ why: "And again.", size: "readable" })),
    ).setting;

    expect([kept.size, changed.size]).toEqual(["working", "readable"]);
  });

  it("is never carried onto the keeper's own opening of the same thing", async () => {
    const { store } = board();
    const diff = setOut(store.propose(proposal({ what: { kind: "diff", ref: "c" } }))).setting;
    setOut(store.propose(proposal({ size: "working" })));

    const opening = setOut(
      await store.keeperOpens({ what: proposal().what, from: diff.id, rung: "unfold" }),
    ).setting;

    expect(opening).not.toHaveProperty("size");
  });
});

describe("taking a setting back", () => {
  const wren = { creature: "wren", sessionId: "s1" };

  it("settles what the caller set out through the store's own path, as the creature's doing", () => {
    const { store, heard } = board();
    const { setting } = setOut(store.propose(proposal()));
    const before = heard.length;

    expect(store.takeBack(wren, setting.id)).toEqual({ ...setting, state: "withdrawn" });

    expect(store.open()).toEqual([]);
    expect(heard.slice(before)).toEqual([
      {
        sessionId: "s1",
        type: "show.settled",
        payload: { id: setting.id, outcome: "withdrawn", by: "creature" },
      },
    ]);
  });

  it("refuses what the keeper pinned, what the keeper opened and what is not the caller's", async () => {
    const { store } = board();
    const pinned = setOut(store.propose(proposal())).setting;
    store.answer(pinned.id, "pinned");
    const diff = setOut(store.propose(proposal({ what: { kind: "diff", ref: "c" } }))).setting;
    const opening = setOut(
      await store.keeperOpens({ what: { kind: "url", ref: "u" }, from: diff.id, rung: "unfold" }),
    ).setting;
    const hals = setOut(store.propose(proposal({ creature: "hal", sessionId: "s2" }))).setting;

    expect(store.takeBack(wren, pinned.id)).toEqual({
      refused: "conflict",
      error: `the keeper pinned ${pinned.id}, so it stays until they let it go`,
    });
    expect(store.takeBack(wren, opening.id)).toEqual({
      refused: "conflict",
      error: `the keeper opened ${opening.id} themselves, so it is theirs to put away`,
    });
    for (const id of [hals.id, "unknown"]) {
      expect(store.takeBack(wren, id)).toEqual({
        refused: "missing",
        error: `nothing you set out is out with the id ${id}; shown lists what is out`,
      });
    }
    expect(store.open()).toHaveLength(4);
  });

  it("is saved like any other change", async () => {
    const storage = memorySettingStorage();
    const store = await SettingStore.load({
      clock: new FakeClock(t0),
      emit: () => undefined,
      storage,
    });
    const { setting } = setOut(store.propose(proposal()));

    store.takeBack(wren, setting.id);

    expect(storage.kept.settings).toEqual([]);
  });
});

function threadsOf(known: Readonly<Record<string, ShowThread>>) {
  return async (sessionId: string): Promise<ShowThread | undefined> => known[sessionId];
}

function opened(outcome: SetOut | ShowRefusal): Setting {
  return setOut(outcome).setting;
}

describe("a setting's lineage", () => {
  it("names the setting it grows from and the creature's origin, on the record and on show.proposed", () => {
    const { store, heard } = board();
    const diff = opened(store.propose(proposal({ what: { kind: "diff", ref: "cs-41" } })));

    const file = opened(store.propose(proposal({ from: diff.id })));

    expect(diff).toMatchObject({ from: null, origin: "creature" });
    expect(file).toMatchObject({ from: diff.id, origin: "creature" });
    expect(heard.at(-1)).toEqual({
      sessionId: "s1",
      type: "show.proposed",
      payload: { setting: file },
    });
  });

  it("is kept by a replacement that names no other from, or names the setting it replaces", () => {
    const { store } = board();
    const diff = opened(store.propose(proposal({ what: { kind: "diff", ref: "cs-41" } })));
    const test = opened(store.propose(proposal({ what: { kind: "file", ref: "plan.test.ts" } })));
    const file = opened(store.propose(proposal({ from: diff.id })));

    const unnamed = opened(store.propose(proposal({ why: "It changed again." })));
    const itself = opened(store.propose(proposal({ from: unnamed.id, why: "And again." })));
    const moved = opened(store.propose(proposal({ from: test.id, why: "It sits by the test." })));

    expect([file.from, unnamed.from, itself.from, moved.from]).toEqual([
      diff.id,
      diff.id,
      diff.id,
      test.id,
    ]);
    expect(store.open().map(({ id }) => id)).toEqual([diff.id, test.id, moved.id]);
  });

  it("never withdraws a setting when the one it grew from is withdrawn or answered", async () => {
    const { store, heard, advanceTo } = board();
    const rests = opened(
      store.propose(proposal({ until: "rests", what: { kind: "diff", ref: "a" } })),
    );
    const timed = opened(
      store.propose(proposal({ until: "2026-11-08T09:10:00Z", what: { kind: "diff", ref: "b" } })),
    );
    const dismissed = opened(store.propose(proposal({ what: { kind: "diff", ref: "c" } })));
    const children = [rests, timed, dismissed].map((parent) =>
      opened(store.propose(proposal({ from: parent.id, what: { kind: "file", ref: parent.id } }))),
    );

    store.rested("s1");
    await advanceTo(t0 + hourMs);
    store.answer(dismissed.id, "dismissed");

    expect(store.open()).toEqual(children);
    expect(settledOf(heard)).toEqual([
      { id: rests.id, outcome: "withdrawn", by: "creature" },
      { id: timed.id, outcome: "withdrawn", by: "time" },
      { id: dismissed.id, outcome: "dismissed", by: "keeper" },
    ]);
  });

  it("names the setting it replaced, whoever set either out, and null when it replaced nothing", async () => {
    const { store, heard } = board();
    const diff = opened(store.propose(proposal({ what: { kind: "diff", ref: "cs-41" } })));
    const first = opened(store.propose(proposal()));
    store.answer(first.id, "pinned");

    const second = opened(store.propose(proposal({ why: "It changed again." })));
    const opening = opened(
      await store.keeperOpens({ what: proposal().what, from: diff.id, rung: "unfold" }),
    );
    const third = opened(store.propose(proposal({ why: "And again." })));
    const elsewhere = opened(store.propose(proposal({ creature: "hal", sessionId: "s2" })));

    expect([diff, first, elsewhere].map(({ replaces }) => replaces)).toEqual([null, null, null]);
    expect([second, opening, third].map(({ replaces }) => replaces)).toEqual([
      first.id,
      second.id,
      opening.id,
    ]);
    expect(
      heard.filter(({ type }) => type !== "show.proposed").map(({ payload }) => payload),
    ).toEqual([
      { id: first.id, outcome: "pinned", by: "keeper" },
      { id: first.id, outcome: "withdrawn", by: "creature" },
      { id: second.id, outcome: "withdrawn", by: "keeper" },
      { id: opening.id, outcome: "withdrawn", by: "creature" },
    ]);
    expect(heard.at(-2)?.payload).toEqual({ setting: third });
  });
});

describe("the keeper's opening", () => {
  const plan = { kind: "file" as const, ref: "docs/plan.md" };

  it("sets out on the thread and for the creature of the setting it grows from, to unfold, with no why", async () => {
    const { store, heard } = board();
    const diff = opened(
      store.propose(proposal({ sessionId: "s4", what: { kind: "diff", ref: "c" } })),
    );

    const file = opened(await store.keeperOpens({ what: plan, from: diff.id, rung: "unfold" }));

    expect(file).toEqual({
      id: expect.any(String),
      creature: "wren",
      sessionId: "s4",
      what: plan,
      rung: "unfold",
      why: "",
      at: "2026-11-08T09:00:00.000Z",
      until: "seen",
      state: "live",
      from: diff.id,
      origin: "keeper",
      replaces: null,
    });
    expect(heard.at(-1)).toEqual({
      sessionId: "s4",
      type: "show.proposed",
      payload: { setting: file },
    });
  });

  it("sets out on the thread it grows from, for that thread's creature or for none", async () => {
    const { store } = board({
      threads: threadsOf({
        s9: { creature: "hal", parent: null },
        s10: { creature: null, parent: "s9" },
      }),
    });

    const fromHal = opened(await store.keeperOpens({ what: plan, from: "s9", rung: "unfold" }));
    const fromChild = opened(await store.keeperOpens({ what: plan, from: "s10", rung: "unfold" }));

    expect(fromHal).toMatchObject({ creature: "hal", sessionId: "s9", from: "s9" });
    expect(fromChild).toMatchObject({ creature: null, sessionId: "s10", from: "s10" });
  });

  it("refuses a from that names no setting still out and no thread, and sets nothing out", async () => {
    const { store, heard } = board({ threads: threadsOf({}) });
    const gone = opened(store.propose(proposal()));
    store.answer(gone.id, "dismissed");
    const before = heard.length;

    for (const from of ["nope", gone.id]) {
      expect(await store.keeperOpens({ what: plan, from, rung: "unfold" })).toEqual({
        refused: "missing",
        error: `no setting out and no thread has the id ${from}`,
      });
    }
    expect(heard).toHaveLength(before);
  });

  it("replaces the owner's setting of the same thing, withdrawn by the keeper", async () => {
    const { store, heard } = board();
    const diff = opened(store.propose(proposal({ what: { kind: "diff", ref: "c" } })));
    const card = opened(store.propose(proposal({ what: plan })));

    const outcome = setOut(await store.keeperOpens({ what: plan, from: diff.id, rung: "unfold" }));

    expect(outcome.replaced?.id).toBe(card.id);
    expect(settledOf(heard)).toEqual([{ id: card.id, outcome: "withdrawn", by: "keeper" }]);
    expect(store.open().map(({ id }) => id)).toEqual([diff.id, outcome.setting.id]);
  });

  it("never spends the hourly limit, in every order of six creature and keeper calls", async () => {
    const limit = 2;
    for (const calls of everyOrder(["creature", "keeper"], 6)) {
      const { store } = board({ hourlyLimit: limit, threads: threadsOf({ s1: noThread }) });
      const answers: string[] = [];
      for (const [index, by] of calls.entries()) {
        const what = { kind: "note" as const, ref: `note ${index}` };
        const outcome =
          by === "keeper"
            ? await store.keeperOpens({ what, from: "s1", rung: "unfold" })
            : store.propose(proposal({ what }));
        answers.push("refused" in outcome ? outcome.refused : outcome.setting.origin);
      }
      expect(answers).toEqual(expectedUnderTheLimit(calls, limit));
    }
  });
});

describe("what a caller may grow from", () => {
  const wren = { creature: "wren", sessionId: "s1" };
  const threads = threadsOf({
    child: { creature: null, parent: "s1" },
    chore: { creature: "wren", parent: null },
    stranger: { creature: null, parent: null },
    hal: { creature: "hal", parent: null },
  });

  it("is a setting its owner set out that is still out, live or pinned, and its own thread", async () => {
    const { store } = board({ threads });
    const live = opened(store.propose(proposal()));
    const pinned = opened(store.propose(proposal({ what: { kind: "diff", ref: "c" } })));
    store.answer(pinned.id, "pinned");
    const seen = opened(store.propose(proposal({ what: { kind: "note", ref: "n" } })));
    store.answer(seen.id, "seen");
    const hals = opened(store.propose(proposal({ creature: "hal", sessionId: "hal" })));
    const strangers = opened(store.propose(proposal({ creature: null, sessionId: "stranger" })));

    const grows = (from: string) => store.canGrowFrom(wren, from);

    expect(await grows(live.id)).toBe(true);
    expect(await grows(pinned.id)).toBe(true);
    expect(await grows("s1")).toBe(true);
    expect(await grows(seen.id)).toBe(false);
    expect(await grows(hals.id)).toBe(false);
    expect(await grows(strangers.id)).toBe(false);
  });

  it("is a thread it spawned or any thread of its creature, and no other thread", async () => {
    const { store } = board({ threads });
    const plain = { creature: null, sessionId: "s1" };

    expect(await store.canGrowFrom(wren, "child")).toBe(true);
    expect(await store.canGrowFrom(wren, "chore")).toBe(true);
    expect(await store.canGrowFrom(wren, "stranger")).toBe(false);
    expect(await store.canGrowFrom(wren, "hal")).toBe(false);
    expect(await store.canGrowFrom(wren, "unknown")).toBe(false);
    expect(await store.canGrowFrom(plain, "child")).toBe(true);
    expect(await store.canGrowFrom(plain, "stranger")).toBe(false);
  });

  it("is a setting the keeper opened from a thread it spawned", async () => {
    const { store } = board({ threads });
    const opening = opened(
      await store.keeperOpens({ what: { kind: "url", ref: "u" }, from: "child", rung: "unfold" }),
    );

    expect(opening).toMatchObject({ creature: null, sessionId: "child" });
    expect(await store.canGrowFrom(wren, opening.id)).toBe(true);
    expect(await store.canGrowFrom({ creature: "hal", sessionId: "hal" }, opening.id)).toBe(false);
  });

  it("is only its own thread when the store knows no threads", async () => {
    const { store } = board();
    expect(await store.canGrowFrom(wren, "s1")).toBe(true);
    expect(await store.canGrowFrom(wren, "child")).toBe(false);
  });
});

type Caller = "creature" | "keeper";

const noThread: ShowThread = { creature: null, parent: null };

function everyOrder(callers: readonly Caller[], length: number): Caller[][] {
  if (length === 0) return [[]];
  return everyOrder(callers, length - 1).flatMap((order) =>
    callers.map((caller) => [...order, caller]),
  );
}

function expectedUnderTheLimit(calls: readonly Caller[], limit: number): string[] {
  let spent = 0;
  return calls.map((by) => {
    if (by === "keeper") return "keeper";
    spent += 1;
    return spent > limit ? "limited" : "creature";
  });
}
