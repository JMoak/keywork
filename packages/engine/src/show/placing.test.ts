import { describe, expect, it } from "vitest";
import { minuteMs } from "../routines/clock.ts";
import { FakeClock } from "../routines/testing.ts";
import { type Arrangement, arrangementsPerMinute, outsideAtOnce } from "./arrangement.ts";
import type { Placement, PlacementsReport, Stage } from "./placements.ts";
import { namedSeats } from "./seat.ts";
import type { Setting, SettingWhat, ShowEvents, ShowEventType } from "./setting.ts";
import { SettingStore, type SettingStoreOptions, type ShowProposal } from "./store.ts";

const t0 = Date.parse("2026-11-08T09:00:00Z");

const wren = { creature: "wren", sessionId: "s1" };

const stage: Stage = { room: "beside", cardsAcross: 4, cardsDown: 3, consoleMaximised: false };

interface Emitted {
  sessionId: string;
  type: ShowEventType;
  payload: ShowEvents[ShowEventType];
}

function board(options: Pick<SettingStoreOptions, "threads"> = {}) {
  const clock = new FakeClock(t0);
  const emitted: Emitted[] = [];
  const store = new SettingStore({
    clock,
    emit: (sessionId, type, payload) => emitted.push({ sessionId, type, payload }),
    ...options,
  });
  const advanceTo = (at: number) => clock.advanceTo(at, async () => undefined);
  const setOut = (overrides: Partial<ShowProposal> = {}): Setting => {
    const outcome = store.propose(proposal(overrides));
    if ("refused" in outcome) throw new Error(outcome.error);
    return outcome.setting;
  };
  const arranged = () =>
    emitted.flatMap(({ type, payload }) =>
      type === "show.arranged" && "arrangement" in payload ? [payload.arrangement] : [],
    );
  return { store, emitted, advanceTo, setOut, arranged };
}

function proposal(overrides: Partial<ShowProposal> = {}): ShowProposal {
  return {
    ...wren,
    what: { kind: "file", ref: "docs/plan.md", title: "The plan" },
    rung: "card",
    why: "The plan changed.",
    until: "seen",
    from: null,
    origin: "creature",
    ...overrides,
  };
}

function note(index: number): SettingWhat {
  return { kind: "note", ref: `note ${index}` };
}

function report(placements: readonly Placement[], said?: { id: string; said: string }) {
  return { stage, placements, ...(said !== undefined && { arrangement: said }) };
}

function refusalOf(outcome: object): string {
  if (!("refused" in outcome)) throw new Error("it was not refused");
  return `${outcome.refused}: ${"error" in outcome ? outcome.error : ""}`;
}

describe("a setting set out outside", () => {
  it("carries where, the seat, the weight and the mood on the record and on show.proposed, and a seat alone means outside", () => {
    const { store, emitted, setOut } = board();

    const seated = setOut({ seat: namedSeats["left-half"], weight: "lead", mood: "calm" });
    const unseated = setOut({ what: note(1), where: "outside" });
    const beside = setOut({ what: note(2) });

    expect(seated).toMatchObject({
      where: "outside",
      seat: { x: 0, y: 0, w: 6, h: 12 },
      weight: "lead",
      mood: "calm",
    });
    expect(unseated.where).toBe("outside");
    expect(unseated).not.toHaveProperty("seat");
    for (const key of ["where", "seat", "weight", "mood"]) expect(beside).not.toHaveProperty(key);
    expect(emitted.map(({ payload }) => payload)).toEqual([
      { setting: seated },
      { setting: unseated },
      { setting: beside },
    ]);
    expect(store.open()).toEqual([seated, unseated, beside]);
  });

  it("is refused before anything is stored or sent when its seat runs off the lattice or sits beside", () => {
    const { store, emitted } = board();

    expect(refusalOf(store.propose(proposal({ seat: { x: 8, y: 0, w: 6, h: 12 } })))).toBe(
      "invalid: the seat does not fit: x 8 + w 6 is 14, past the stage's 12 columns",
    );
    expect(refusalOf(store.propose(proposal({ seat: { x: 0, y: 0, w: 1.5, h: 12 } })))).toContain(
      "whole twelfths",
    );
    expect(
      refusalOf(store.propose(proposal({ where: "beside", seat: namedSeats["left-half"] }))),
    ).toBe(
      "invalid: a seat is a place outside, so it cannot go with where beside; leave one of them out",
    );
    expect(store.open()).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it("is kept where it stands and at its weight by a replacement that names neither, and its mood is not", async () => {
    const { store, setOut } = board();
    setOut({ seat: namedSeats["left-half"], weight: "lead", mood: "calm" });

    const refreshed = setOut({ why: "It moved." });
    await store.placed(
      "s1",
      report([
        { id: refreshed.id, where: "outside", seat: namedSeats["right-half"], by: "keeper" },
      ]),
    );
    const whereItStands = setOut({ why: "And again." });
    const elsewhere = setOut({ why: "Now beside.", where: "beside", weight: "aside" });

    expect(refreshed).toMatchObject({
      where: "outside",
      seat: namedSeats["left-half"],
      weight: "lead",
    });
    expect(refreshed).not.toHaveProperty("mood");
    expect(whereItStands).toMatchObject({ where: "outside", seat: namedSeats["right-half"] });
    expect(elsewhere).toMatchObject({ where: "beside", weight: "aside" });
    expect(elsewhere).not.toHaveProperty("seat");
  });

  it("stops at twelve of one owner's standing outside at once, in words, and counts where they stand", async () => {
    const { store, setOut } = board();
    const outside = Array.from({ length: outsideAtOnce }, (_, index) =>
      setOut({ what: note(index), where: "outside" }),
    );
    const one = outside[0] as Setting;

    expect(refusalOf(store.propose(proposal({ where: "outside" })))).toBe(
      "limited: 12 of your settings already stand outside, the most that may at once; withdraw one that has gone stale, or leave where out and this sets out beside the conversation",
    );
    expect(store.propose(proposal())).toHaveProperty("setting");
    expect(
      store.propose(proposal({ creature: "hal", what: note(99), where: "outside" })),
    ).toHaveProperty("setting");
    expect(store.propose(proposal({ what: one.what, where: "outside" }))).toHaveProperty("setting");

    const replacement = store.open().find(({ replaces }) => replaces === one.id) as Setting;
    await store.placed("s1", report([{ id: replacement.id, where: "inside", by: "keeper" }]));

    expect(store.propose(proposal({ what: note(100), where: "outside" }))).toHaveProperty(
      "setting",
    );
  });
});

describe("the console's placements", () => {
  it("are kept per session as the whole picture, the latest replacing the last, and are where things stand", async () => {
    const { store, setOut } = board();
    const plan = setOut({ where: "outside" });
    const card = setOut({ what: note(1) });
    const seat = namedSeats["right-half"];

    expect(store.standingFor(wren)).toEqual({
      out: [
        { setting: plan, where: "outside" },
        { setting: card, where: "beside" },
      ],
      stage: undefined,
    });

    await store.placed("s1", report([{ id: plan.id, where: "outside", seat, by: "console" }]));

    expect(store.standingFor(wren)).toEqual({
      out: [
        { setting: plan, where: "outside", seat, by: "console" },
        { setting: card, where: "beside" },
      ],
      stage,
    });

    const maximised = { ...stage, room: "over" as const, consoleMaximised: true };
    await store.placed("s1", {
      stage: maximised,
      placements: [{ id: card.id, where: "inside", by: "keeper" }],
    });

    expect(store.standingFor(wren)).toEqual({
      out: [
        { setting: plan, where: "outside" },
        { setting: card, where: "inside", by: "keeper" },
      ],
      stage: maximised,
    });
  });

  it("are taken for a session with something out or a thread the store knows, and refused for any other", async () => {
    const { store } = board({
      threads: async (id) => (id === "s9" ? { creature: null, parent: null } : undefined),
    });

    expect(await store.placed("nope", report([]))).toEqual({
      refused: "missing",
      error: "no session has the id nope",
    });
    expect(store.standingFor(wren).stage).toBeUndefined();

    expect(await store.placed("s9", report([]))).toBeUndefined();
    expect(store.standingFor(wren).stage).toEqual(stage);

    store.removed("s9");
    expect(store.standingFor(wren).stage).toBeUndefined();
  });
});

describe("an arrangement", () => {
  it("is announced on the caller's thread as show.arranged, in the caller's order, and moves what stood beside outside", () => {
    const { store, emitted, setOut } = board();
    const plan = setOut();
    const card = setOut({ what: note(1), seat: namedSeats["top-left"] });

    const arrangement = store.arrange(wren, {
      panes: [card.id, plan.id],
      shape: "lead-and-stack",
      lead: plan.id,
      over: "display",
      mood: "eager",
    });

    expect(arrangement).toEqual({
      id: expect.any(String),
      creature: "wren",
      sessionId: "s1",
      at: "2026-11-08T09:00:00.000Z",
      panes: [card.id, plan.id],
      shape: "lead-and-stack",
      lead: plan.id,
      over: "display",
      mood: "eager",
    });
    expect(emitted.at(-1)).toEqual({
      sessionId: "s1",
      type: "show.arranged",
      payload: { arrangement },
    });
    expect(store.open()).toEqual([
      { ...plan, where: "outside" },
      { ...withoutSeat(card), where: "outside" },
    ]);
  });

  it("composes seats outright, keeps them on the record, and takes everything outside when no panes are named", () => {
    const { store, setOut } = board();
    const plan = setOut({ where: "outside" });
    const card = setOut({ what: note(1), where: "outside" });
    const beside = setOut({ what: note(2) });
    const aside = setOut({ what: note(3) });
    const seats = [
      { id: plan.id, seat: namedSeats["left-two-thirds"] },
      { id: beside.id, seat: namedSeats["right-third"] },
    ];

    const composed = store.arrange(wren, { seats }) as Arrangement;
    const everything = store.arrange(wren, { relation: "notes" }) as Arrangement;
    const chosen = store.arrange(wren, {}) as Arrangement;

    expect(composed).toMatchObject({ panes: [plan.id, card.id, beside.id], seats });
    expect(everything).toMatchObject({ panes: [plan.id, card.id, beside.id], relation: "notes" });
    expect(chosen.panes).toEqual([plan.id, card.id, beside.id]);
    for (const key of ["shape", "relation", "seats", "lead", "over", "mood"]) {
      expect(chosen).not.toHaveProperty(key);
    }
    expect(store.open().find(({ id }) => id === aside.id)).toEqual(aside);
  });

  it("takes a pane by the ref or the title it was shown with as well as by its id", () => {
    const { store, setOut } = board();
    const plan = setOut();
    const card = setOut({ what: note(1) });

    const arrangement = store.arrange(wren, {
      panes: ["the plan", "note 1"],
      lead: "docs/plan.md",
    });

    expect(arrangement).toMatchObject({ panes: [plan.id, card.id], lead: plan.id });
  });

  it("refuses anything that is not the caller's own setting still out, and says what is", async () => {
    const { store, emitted, setOut } = board();
    const plan = setOut();
    const hals = setOut({ creature: "hal", what: note(1) });
    const seen = setOut({ what: note(2) });
    store.answer(seen.id, "seen");
    const opened = await store.keeperOpens({ what: note(3), from: plan.id, rung: "unfold" });
    if ("refused" in opened) throw new Error(opened.error);
    const before = emitted.length;
    const yours = `what you have out is "The plan" (${plan.id})`;

    for (const stranger of [hals.id, seen.id, opened.setting.id, "nope"]) {
      expect(refusalOf(store.arrange(wren, { panes: [plan.id, stranger], shape: "grid" }))).toBe(
        `missing: nothing you set out is out as ${JSON.stringify(stranger)}; ${yours}`,
      );
    }
    expect(refusalOf(store.arrange(wren, { shape: "grid" }))).toBe(
      `missing: nothing of yours is outside to arrange; show something with where outside, or say panes "all" to move what you have out beside the conversation outside: ${yours}`,
    );
    expect(refusalOf(store.arrange({ creature: "ivy", sessionId: "s5" }, { panes: ["x"] }))).toBe(
      'missing: nothing you set out is out as "x"; you have nothing out, so show something first',
    );
    expect(emitted).toHaveLength(before);
    expect(store.open().find(({ id }) => id === plan.id)).toEqual(plan);
  });

  it("refuses two instructions, a seat that does not fit, and a seat or a lead outside the panes", () => {
    const { store, emitted, setOut } = board();
    const plan = setOut();
    const card = setOut({ what: note(1) });
    const before = emitted.length;
    const seat = namedSeats["left-half"];

    expect(
      refusalOf(store.arrange(wren, { panes: [plan.id], shape: "grid", relation: "tasks" })),
    ).toBe(
      "invalid: shape, relation and seats are three ways to ask for one arrangement; give one of them, or none and the console chooses",
    );
    expect(
      refusalOf(
        store.arrange(wren, { seats: [{ id: plan.id, seat: { x: 9, y: 0, w: 6, h: 6 } }] }),
      ),
    ).toBe(
      `invalid: the seat for ${plan.id} does not fit: x 9 + w 6 is 15, past the stage's 12 columns`,
    );
    expect(
      refusalOf(
        store.arrange(wren, {
          seats: [
            { id: plan.id, seat },
            { id: plan.id, seat },
          ],
        }),
      ),
    ).toBe(`invalid: seats places ${plan.id} twice; give it one seat`);
    expect(
      refusalOf(store.arrange(wren, { panes: [plan.id], seats: [{ id: card.id, seat }] })),
    ).toBe(
      `invalid: seats places ${card.id}, which is not among panes; add it to panes, or leave panes out`,
    );
    expect(refusalOf(store.arrange(wren, { panes: [plan.id], lead: card.id }))).toBe(
      `invalid: lead names ${card.id}, which is not among the panes being arranged; add it to panes, or leave panes out`,
    );
    expect(emitted).toHaveLength(before);
  });

  it("stops at twelve outside at once and at twelve a minute for one session, in words", async () => {
    const { store, advanceTo, setOut, arranged } = board();
    const outside = Array.from({ length: outsideAtOnce }, (_, index) =>
      setOut({ what: note(index), where: "outside" }),
    );
    const beside = setOut();

    expect(refusalOf(store.arrange(wren, { panes: [beside.id], shape: "grid" }))).toBe(
      "limited: that would put 13 of your settings outside, and 12 is the most that may stand outside at once; name fewer panes, or withdraw what has gone stale first",
    );
    for (let count = 0; count < arrangementsPerMinute; count += 1) {
      expect(store.arrange(wren, { shape: "grid" })).toHaveProperty("id");
    }
    expect(refusalOf(store.arrange(wren, { shape: "grid" }))).toBe(
      "limited: this thread has arranged 12 times in the last minute, the most it may; the next may go in 60 seconds, and one arrange can seat every pane at once",
    );
    expect(store.arrange({ creature: "wren", sessionId: "s2" }, { shape: "rows" })).toHaveProperty(
      "id",
    );
    expect(arranged()).toHaveLength(arrangementsPerMinute + 1);
    expect(arranged()[0]?.panes).toEqual(outside.map(({ id }) => id));

    await advanceTo(t0 + minuteMs);
    expect(store.arrange(wren, { shape: "grid" })).toHaveProperty("id");
  });

  it("names a pane the keeper has placed but leaves its record as the keeper left it", async () => {
    const { store, setOut } = board();
    const held = setOut();
    const free = setOut({ what: note(1) });
    await store.placed(
      "s1",
      report([{ id: held.id, where: "outside", seat: namedSeats["top-right"], by: "keeper" }]),
    );
    const seat = namedSeats["left-half"];

    const arrangement = store.arrange(wren, {
      seats: [
        { id: held.id, seat },
        { id: free.id, seat },
      ],
    });

    expect(arrangement).toMatchObject({ panes: [held.id, free.id] });
    expect(store.open()).toEqual([held, { ...free, where: "outside", seat }]);
  });
});

describe("waiting on the console", () => {
  const naming = (id: string) => (heard: PlacementsReport) =>
    heard.placements.some((placement) => placement.id === id);

  it("hears the report it was waiting for and no other, or gives up after a second and a half", async () => {
    const { store, advanceTo, setOut } = board();
    const plan = setOut({ where: "outside" });
    const answer = report([{ id: plan.id, where: "outside", by: "console" }]);

    const heard = store.reportNaming(naming(plan.id));
    await store.placed("s1", report([]));
    await store.placed("s1", answer);
    expect(await heard).toEqual(answer);

    let settled = false;
    const unanswered = store.reportNaming(naming("another"));
    void unanswered.then(() => {
      settled = true;
    });
    await advanceTo(t0 + 1_499);
    expect(settled).toBe(false);
    await advanceTo(t0 + 1_500);
    expect(await unanswered).toBeUndefined();
  });

  it("stops waiting once nothing has ever answered, and waits again when a report comes", async () => {
    const { store, advanceTo, setOut } = board();
    const plan = setOut({ where: "outside" });

    const first = store.reportNaming(naming(plan.id));
    await advanceTo(t0 + 1_500);
    expect(await first).toBeUndefined();
    expect(await store.reportNaming(naming(plan.id))).toBeUndefined();

    await store.placed("s1", report([]));
    const answer = report([{ id: plan.id, where: "outside", by: "console" }]);
    const again = store.reportNaming(naming(plan.id));
    await store.placed("s1", answer);
    expect(await again).toEqual(answer);
  });
});

function withoutSeat({ seat: _seat, ...setting }: Setting): Setting {
  return setting;
}
