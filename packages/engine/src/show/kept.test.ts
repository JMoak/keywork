import { describe, expect, it } from "vitest";
import { hourMs, minuteMs } from "../routines/clock.ts";
import { FakeClock } from "../routines/testing.ts";
import { keptSettingsOf, keptSettingsText } from "./file.ts";
import {
  type KeptSettings,
  memorySettingStorage,
  nothingKept,
  type SettingStorage,
} from "./kept.ts";
import type { ShowThread, ThreadLookup } from "./lineage.ts";
import type { Setting, SettingAnswer, ShowEvents, ShowEventType } from "./setting.ts";
import { type SetOut, SettingStore, type ShowProposal, type ShowRefusal } from "./store.ts";

const t0 = Date.parse("2026-11-08T09:00:00Z");

interface Heard {
  sessionId: string;
  type: ShowEventType;
  payload: ShowEvents[ShowEventType];
}

interface Opening {
  at?: number;
  threads?: ThreadLookup;
  hourlyLimit?: number;
}

async function openedOver(storage: SettingStorage, opening: Opening = {}) {
  const clock = new FakeClock(opening.at ?? t0);
  const heard: Heard[] = [];
  const store = await SettingStore.load({
    storage,
    clock,
    emit: (sessionId, type, payload) => heard.push({ sessionId, type, payload }),
    threads: opening.threads ?? everyThread,
    hourlyLimit: opening.hourlyLimit,
  });
  const advanceTo = (at: number) => clock.advanceTo(at, async () => undefined);
  return { store, clock, heard, advanceTo };
}

const everyThread: ThreadLookup = async () => ({ creature: null, parent: null });

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

function setOut(outcome: SetOut | ShowRefusal): Setting {
  if ("refused" in outcome) throw new Error(outcome.error);
  return outcome.setting;
}

function idsOf(settings: readonly Setting[]): string[] {
  return settings.map(({ id }) => id);
}

describe("a store opened from what was kept", () => {
  it("brings live and pinned settings back exactly: ids, times, lineage and order, with no event", async () => {
    const storage = memorySettingStorage();
    const before = await openedOver(storage);
    const diff = setOut(before.store.propose(proposal({ what: { kind: "diff", ref: "cs-41" } })));
    await before.advanceTo(t0 + minuteMs);
    const plan = setOut(before.store.propose(proposal({ from: diff.id })));
    before.store.answer(plan.id, "pinned");
    await before.advanceTo(t0 + 2 * minuteMs);
    const again = setOut(before.store.propose(proposal({ what: diff.what, why: "Again." })));
    const opening = setOut(
      await before.store.keeperOpens({
        what: { kind: "url", ref: "https://example.com/r1" },
        from: plan.id,
        rung: "unfold",
      }),
    );
    const timed = setOut(
      before.store.propose(
        proposal({
          creature: null,
          sessionId: "s2",
          what: { kind: "note", ref: "Lunch at noon." },
          until: "2026-11-08T10:00:00Z",
        }),
      ),
    );
    const out = before.store.open();
    before.store.close();

    const after = await openedOver(storage, { at: t0 + 20 * minuteMs });

    expect(after.store.open()).toEqual(out);
    expect(idsOf(out)).toEqual([plan.id, again.id, opening.id, timed.id]);
    expect(out.map(({ state, from, origin, replaces }) => [state, from, origin, replaces])).toEqual(
      [
        ["pinned", diff.id, "creature", null],
        ["live", null, "creature", diff.id],
        ["live", plan.id, "keeper", null],
        ["live", null, "creature", null],
      ],
    );
    expect(out.map(({ at }) => at)).toEqual([
      "2026-11-08T09:01:00.000Z",
      "2026-11-08T09:02:00.000Z",
      "2026-11-08T09:02:00.000Z",
      "2026-11-08T09:02:00.000Z",
    ]);
    expect(after.heard).toEqual([]);
  });

  it("withdraws a live setting whose time passed while stopped, silently, and keeps a pinned one past its time", async () => {
    const storage = memorySettingStorage();
    const before = await openedOver(storage);
    const timed = setOut(before.store.propose(proposal({ until: "2026-11-08T09:30:00Z" })));
    const pinned = setOut(
      before.store.propose(
        proposal({ what: { kind: "diff", ref: "c" }, until: "2026-11-08T09:10:00Z" }),
      ),
    );
    before.store.answer(pinned.id, "pinned");
    before.store.close();

    const after = await openedOver(storage, { at: Date.parse("2026-11-08T09:30:00Z") });

    expect(after.store.open()).toEqual([{ ...pinned, state: "pinned" }]);
    expect(idsOf(storage.kept.settings)).toEqual([pinned.id]);
    expect(after.heard).toEqual([]);
    expect(idsOf(before.store.open())).toContain(timed.id);
  });

  it("brings back a live setting whose time is still ahead, and withdraws it by time when it comes", async () => {
    const storage = memorySettingStorage();
    const before = await openedOver(storage);
    const timed = setOut(before.store.propose(proposal({ until: "2026-11-08T09:30:00Z" })));
    before.store.close();

    const after = await openedOver(storage, { at: t0 + 20 * minuteMs });
    expect(after.store.open()).toEqual([timed]);
    await after.advanceTo(t0 + 31 * minuteMs);

    expect(after.store.open()).toEqual([]);
    expect(after.heard).toEqual([
      {
        sessionId: "s1",
        type: "show.settled",
        payload: { id: timed.id, outcome: "withdrawn", by: "time" },
      },
    ]);
    expect(storage.kept.settings).toEqual([]);
  });

  it("withdraws every live rests setting, since a stopped server is a rested thread, and keeps a pinned one", async () => {
    const storage = memorySettingStorage();
    const before = await openedOver(storage);
    setOut(before.store.propose(proposal({ until: "rests" })));
    setOut(
      before.store.propose(
        proposal({
          creature: null,
          sessionId: "s2",
          until: "rests",
          what: { kind: "note", ref: "n" },
        }),
      ),
    );
    const pinned = setOut(
      before.store.propose(proposal({ until: "rests", what: { kind: "report", ref: "r1" } })),
    );
    before.store.answer(pinned.id, "pinned");
    const seen = setOut(before.store.propose(proposal({ what: { kind: "diff", ref: "c" } })));
    before.store.close();

    const after = await openedOver(storage, { at: t0 + minuteMs });

    expect(idsOf(after.store.open())).toEqual([pinned.id, seen.id]);
    expect(idsOf(storage.kept.settings)).toEqual([pinned.id, seen.id]);
    expect(after.heard).toEqual([]);
  });

  it("withdraws the live settings of a session that no longer exists, silently, asking once per session", async () => {
    const storage = memorySettingStorage();
    const before = await openedOver(storage);
    const kept = setOut(before.store.propose(proposal()));
    setOut(before.store.propose(proposal({ creature: "hal", sessionId: "gone" })));
    setOut(
      before.store.propose(
        proposal({ creature: "hal", sessionId: "gone", what: { kind: "diff", ref: "c" } }),
      ),
    );
    const pinned = setOut(
      before.store.propose(
        proposal({ creature: "hal", sessionId: "gone", what: { kind: "note", ref: "n" } }),
      ),
    );
    before.store.answer(pinned.id, "pinned");
    before.store.close();
    const asked: string[] = [];
    const threads: ThreadLookup = async (sessionId) => {
      asked.push(sessionId);
      return sessionId === "s1" ? wrensThread : undefined;
    };

    const after = await openedOver(storage, { at: t0 + minuteMs, threads });

    expect(idsOf(after.store.open())).toEqual([kept.id, pinned.id]);
    expect(idsOf(storage.kept.settings)).toEqual([kept.id, pinned.id]);
    expect(asked).toEqual(["s1", "gone"]);
    expect(after.heard).toEqual([]);
  });

  it("keeps a live setting whose session cannot be looked up, since it is not known to be gone", async () => {
    const storage = memorySettingStorage();
    const before = await openedOver(storage);
    const kept = setOut(before.store.propose(proposal()));
    before.store.close();

    const after = await openedOver(storage, {
      at: t0 + minuteMs,
      threads: async () => {
        throw new Error("EACCES: permission denied, scandir 'sessions'");
      },
    });

    expect(after.store.open()).toEqual([kept]);
  });

  it("asks about no session when nothing live was kept, and saves nothing it did not change", async () => {
    const asked: string[] = [];
    const storage = countingStorage(memorySettingStorage());
    const before = await openedOver(storage);
    const pinned = setOut(before.store.propose(proposal()));
    before.store.answer(pinned.id, "pinned");
    before.store.close();
    const saves = storage.saves();

    await openedOver(storage, {
      at: t0 + minuteMs,
      threads: async (sessionId) => {
        asked.push(sessionId);
        return undefined;
      },
    });

    expect(asked).toEqual([]);
    expect(storage.saves()).toBe(saves);
  });
});

describe("the hourly limit across a stop", () => {
  it("counts what the creature set out before the stop while it is still inside the hour", async () => {
    const storage = memorySettingStorage();
    const before = await openedOver(storage, { hourlyLimit: 2 });
    setOut(before.store.propose(proposal()));
    await before.advanceTo(t0 + 10 * minuteMs);
    setOut(before.store.propose(proposal({ why: "It changed again." })));
    setOut(
      await before.store.keeperOpens({
        what: { kind: "url", ref: "u" },
        from: "s1",
        rung: "unfold",
      }),
    );
    before.store.close();

    const after = await openedOver(storage, { at: t0 + 30 * minuteMs, hourlyLimit: 2 });
    const note = (ref: string) => proposal({ what: { kind: "note", ref } });

    expect(after.store.propose(note("a"))).toMatchObject({ refused: "limited" });
    setOut(after.store.propose({ ...note("hal's"), creature: "hal" }));
    setOut(
      await after.store.keeperOpens({
        what: { kind: "url", ref: "v" },
        from: "s1",
        rung: "unfold",
      }),
    );
    await after.advanceTo(t0 + hourMs + 1);
    setOut(after.store.propose(note("b")));
    expect(after.store.propose(note("c"))).toMatchObject({ refused: "limited" });
    await after.advanceTo(t0 + hourMs + 10 * minuteMs + 1);
    setOut(after.store.propose(note("c")));
  });

  it("keeps only the creature's spends still inside the hour, never the keeper's", async () => {
    const storage = memorySettingStorage();
    const before = await openedOver(storage);
    setOut(before.store.propose(proposal()));
    await before.advanceTo(t0 + 50 * minuteMs);
    setOut(before.store.propose(proposal({ creature: null, what: { kind: "note", ref: "n" } })));
    const opening = setOut(
      await before.store.keeperOpens({
        what: { kind: "url", ref: "u" },
        from: "s1",
        rung: "unfold",
      }),
    );
    const spentBefore = storage.kept.spent;
    await before.advanceTo(t0 + hourMs + minuteMs);
    before.store.answer(opening.id, "seen");
    const spentAnHourOn = storage.kept.spent;
    before.store.close();

    await openedOver(storage, { at: t0 + 2 * hourMs });

    expect(spentBefore).toEqual([
      { owner: "creature wren", at: "2026-11-08T09:00:00.000Z" },
      { owner: "thread s1", at: "2026-11-08T09:50:00.000Z" },
    ]);
    expect(spentAnHourOn).toEqual([{ owner: "thread s1", at: "2026-11-08T09:50:00.000Z" }]);
    expect(storage.kept.spent).toEqual([]);
  });
});

describe("what the store keeps", () => {
  it("is every live and pinned setting after each change, and a setting leaves it when it settles", async () => {
    const storage = memorySettingStorage();
    const { store, advanceTo } = await openedOver(storage);
    const keptMatches = () => expect(storage.kept.settings).toEqual(store.open());
    const seen = setOut(store.propose(proposal()));
    const rests = setOut(
      store.propose(proposal({ until: "rests", what: { kind: "diff", ref: "c" } })),
    );
    const timed = setOut(
      store.propose(proposal({ until: "2026-11-08T09:10:00Z", what: { kind: "note", ref: "n" } })),
    );
    const pinned = setOut(store.propose(proposal({ what: { kind: "report", ref: "r1" } })));
    const removed = setOut(store.propose(proposal({ creature: null, sessionId: "s9" })));
    keptMatches();

    store.answer(seen.id, "seen");
    keptMatches();
    store.rested("s1");
    keptMatches();
    await advanceTo(t0 + 15 * minuteMs);
    keptMatches();
    store.answer(pinned.id, "pinned");
    keptMatches();
    store.removed("s9");
    keptMatches();
    expect(idsOf(storage.kept.settings)).toEqual([pinned.id]);
    store.answer(pinned.id, "unpinned");

    expect(storage.kept.settings).toEqual([]);
    expect([rests, timed, removed].map(({ id }) => idsOf(store.open()).includes(id))).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("is saved only when something changed", async () => {
    const storage = countingStorage(memorySettingStorage());
    const { store } = await openedOver(storage, { hourlyLimit: 1 });
    const setting = setOut(store.propose(proposal()));
    const afterOne = storage.saves();

    store.rested("s1");
    store.removed("s2");
    store.answer(setting.id, "unpinned");
    store.answer("nope", "seen");
    store.propose(proposal({ what: { kind: "note", ref: "over the limit" } }));
    store.propose(proposal({ until: "2026-11-08T08:00:00Z" }));

    expect(afterOne).toBe(1);
    expect(storage.saves()).toBe(1);
  });

  it("starts empty from nothing kept", async () => {
    const { store } = await openedOver(memorySettingStorage(nothingKept));
    expect(store.open()).toEqual([]);
  });
});

describe("save then load", () => {
  const steps = {
    "wren shows a diff": ({ store }: World) =>
      void store.propose(proposal({ what: { kind: "diff", ref: "cs-1" } })),
    "wren grows a file from the newest setting": ({ store }: World) =>
      void store.propose(proposal({ from: newestIdIn(store) })),
    "a plain thread shows a note until it rests": ({ store }: World) =>
      void store.propose(
        proposal({ creature: null, sessionId: "s2", until: "rests", what: noteWhat }),
      ),
    "hal shows a report until half past": ({ store }: World) =>
      void store.propose(
        proposal({
          creature: "hal",
          sessionId: "s3",
          until: "2026-11-08T09:30:00+00:00",
          what: { kind: "report", ref: "r1" },
        }),
      ),
    "the keeper opens a link from the newest setting": async ({ store }: World) =>
      void (await store.keeperOpens({
        what: { kind: "url", ref: "https://example.com" },
        from: newestIdIn(store) ?? "s1",
        rung: "unfold",
      })),
    "the keeper pins the oldest live setting": ({ store }: World) =>
      answerFirst(store, "live", "pinned"),
    "the keeper sees the newest live setting": ({ store }: World) =>
      answerFirst(store, "live", "seen", [...store.open()].reverse()),
    "the plain thread rests": ({ store }: World) => store.rested("s2"),
    "wren's thread is removed": ({ store }: World) => store.removed("s1"),
  };
  type StepName = keyof typeof steps;

  it("brings back every live and pinned setting and its lineage exactly, after every history of four steps", async () => {
    const names = Object.keys(steps) as StepName[];
    for (const history of everyHistory(names, 4)) {
      const storage = textStorage();
      const world = await openedOver(storage);
      for (const [index, name] of history.entries()) {
        await world.advanceTo(t0 + (index + 1) * minuteMs);
        await steps[name](world);
        expect(textOf(storage.kept().settings), history.join(", ")).toBe(
          textOf(world.store.open()),
        );
      }
      world.store.close();

      const reopened = await openedOver(storage, { at: world.clock.now() });

      expect(textOf(reopened.store.open()), history.join(", ")).toBe(
        textOf(world.store.open().filter(outlivesAStop)),
      );
    }
  });
});

interface World {
  store: SettingStore;
}

const wrensThread: ShowThread = { creature: "wren", parent: null };

const noteWhat = { kind: "note" as const, ref: "Lunch at noon." };

function newestIdIn(store: SettingStore): string | null {
  return store.open().at(-1)?.id ?? null;
}

function answerFirst(
  store: SettingStore,
  state: Setting["state"],
  answer: SettingAnswer,
  among: readonly Setting[] = store.open(),
): void {
  const first = among.find((setting) => setting.state === state);
  if (first !== undefined) store.answer(first.id, answer);
}

function outlivesAStop(setting: Setting): boolean {
  return setting.state === "pinned" || setting.until !== "rests";
}

function textOf(settings: readonly Setting[]): string {
  return JSON.stringify(settings);
}

function everyHistory<Name>(names: readonly Name[], length: number): Name[][] {
  if (length === 0) return [[]];
  return everyHistory(names, length - 1).flatMap((history) =>
    names.map((name) => [...history, name]),
  );
}

function textStorage(): SettingStorage & { kept(): KeptSettings } {
  let text: string | undefined;
  const kept = () => (text === undefined ? nothingKept : keptSettingsOf(text));
  return {
    kept,
    load: kept,
    save: (next) => {
      text = keptSettingsText(next);
    },
  };
}

function countingStorage(storage: SettingStorage): SettingStorage & { saves(): number } {
  let saves = 0;
  return {
    load: () => storage.load(),
    save: (kept) => {
      saves += 1;
      storage.save(kept);
    },
    saves: () => saves,
  };
}
