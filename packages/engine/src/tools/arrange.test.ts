import { describe, expect, it } from "vitest";
import { FakeClock } from "../routines/testing.ts";
import type { Arrangement } from "../show/arrangement.ts";
import type { Placement } from "../show/placements.ts";
import type { Seat } from "../show/seat.ts";
import type { Setting } from "../show/setting.ts";
import { SettingStore, type ShowProposal } from "../show/store.ts";
import { arrangeTool } from "./arrange.ts";
import type { ShowTarget } from "./show.ts";

const t0 = Date.parse("2026-11-08T09:00:00Z");

const stage = { room: "beside", cardsAcross: 4, cardsDown: 3, consoleMaximised: false } as const;

function staged() {
  const clock = new FakeClock(t0);
  const arranged: Arrangement[] = [];
  const settings = new SettingStore({
    clock,
    emit: (_sessionId, type, payload) => {
      if (type === "show.arranged" && "arrangement" in payload) arranged.push(payload.arrangement);
    },
  });
  const target: ShowTarget = { creature: "wren", sessionId: "s1", settings: () => settings };
  const setOut = (overrides: Partial<ShowProposal>): Setting => {
    const outcome = settings.propose({
      creature: "wren",
      sessionId: "s1",
      what: { kind: "file", ref: "docs/plan.md", title: "The plan" },
      rung: "card",
      why: "",
      until: "seen",
      from: null,
      origin: "creature",
      ...overrides,
    });
    if ("refused" in outcome) throw new Error(outcome.error);
    return outcome.setting;
  };
  const answers = (placements: readonly Placement[], said: string) =>
    settings.placed("s1", {
      stage,
      placements,
      arrangement: { id: (arranged.at(-1) as Arrangement).id, said },
    });
  const unanswered = () => clock.advanceTo(clock.now() + 1_500, async () => undefined);
  return { tool: arrangeTool(target), settings, arranged, setOut, answers, unanswered };
}

describe("the arrange tool", () => {
  it("goes back to the seats that stood before the last arrangement, and says when there are none", async () => {
    const { tool, arranged, setOut, answers } = staged();
    const plan = setOut({ where: "outside" });
    const notes = setOut({ what: { kind: "note", ref: "Three things." }, where: "outside" });
    const stand = (planSeat: Seat, notesSeat: Seat): Placement[] => [
      { id: plan.id, where: "outside", seat: planSeat, by: "creature" },
      { id: notes.id, where: "outside", seat: notesSeat, by: "creature" },
    ];
    const led = stand({ x: 0, y: 0, w: 8, h: 12 }, { x: 8, y: 0, w: 4, h: 12 });
    const even = stand({ x: 0, y: 0, w: 6, h: 12 }, { x: 6, y: 0, w: 6, h: 12 });
    const done = async (args: Record<string, unknown>, standing: Placement[]): Promise<string> => {
      const answering = tool.execute(args);
      await answers(standing, "");
      return answering;
    };
    const nothingBefore =
      "Not arranged: there is nothing to go back to: you have made no arrangement in this conversation since your windows last stood outside.";

    expect(await tool.execute({ back: true })).toBe(nothingBefore);
    await done({ shape: "lead-and-stack", lead: "The plan" }, led);
    await done({ shape: "grid" }, even);

    expect(await done({ shape: "previous", mood: "calm" }, led)).toMatch(
      /^Went back one arrangement, moving calmly: 2 panes are back in the seats they had before it[.] Outside now: /,
    );
    expect(arranged.at(-1)).toMatchObject({
      panes: [plan.id, notes.id],
      seats: [
        { id: plan.id, seat: { x: 0, y: 0, w: 8, h: 12 } },
        { id: notes.id, seat: { x: 8, y: 0, w: 4, h: 12 } },
      ],
      mood: "calm",
    });
    expect(await tool.execute({ back: true })).toBe(nothingBefore);
    expect(await tool.execute({ back: true, shape: "grid" })).toMatch(
      /^Not arranged: back goes alone or with a mood/,
    );
  });

  it("leaves the panes it names standing alone when the rest are sent beside", async () => {
    const { tool, arranged, setOut, answers } = staged();
    const plan = setOut({ where: "outside" });
    const notes = setOut({ what: { kind: "note", ref: "Three things." }, where: "outside" });

    const answering = tool.execute({ seats: { "The plan": "center" }, rest: "step back" });
    await answers(
      [
        { id: plan.id, where: "outside", seat: { x: 3, y: 3, w: 6, h: 6 }, by: "creature" },
        { id: notes.id, where: "beside", by: "console", note: "stepped back as you asked" },
      ],
      "",
    );

    expect(await answering).toBe(
      `Arranged 1 pane in the seats you composed. Outside now: "The plan" (${plan.id}) in the center. Back beside the conversation as a card (stepped back as you asked): "Three things." (${notes.id}). Name it in arrange to set it out again.`,
    );
    expect(arranged.at(-1)).toMatchObject({ panes: [plan.id], rest: "beside" });
    expect(await tool.execute({ shape: "grid", rest: "stay" })).toMatch(
      /^Not arranged: a shape or a relation re-lays the stage/,
    );
  });

  it("puts the large seat on the side it is told, and refuses a side with seats", async () => {
    const { tool, arranged, setOut, answers } = staged();
    const plan = setOut({ where: "outside" });
    const notes = setOut({ what: { kind: "note", ref: "Three things." }, where: "outside" });

    const answering = tool.execute({ lead: "The plan", side: "on the right", mood: "decided" });
    await answers(
      [
        { id: plan.id, where: "outside", seat: { x: 4, y: 0, w: 8, h: 12 }, by: "creature" },
        { id: notes.id, where: "outside", seat: { x: 0, y: 0, w: 4, h: 12 }, by: "creature" },
      ],
      "",
    );

    expect(await answering).toMatch(
      /^Arranged 2 panes, the layout left to the console, the large seat on the right, moving decisively, the nearest mood to "decided"[.] Outside now: /,
    );
    expect(arranged.at(-1)).toMatchObject({ lead: plan.id, side: "right", mood: "decisive" });
    expect(await tool.execute({ seats: { "The plan": "center" }, side: "left" })).toMatch(
      /^Not arranged: side says where the lead stands/,
    );
  });

  it("marks a pane without moving anything, and clears the mark again", async () => {
    const { tool, settings, arranged, setOut } = staged();
    const plan = setOut({ where: "outside" });
    const changed: Setting[] = [];
    const marks = () => settings.open().map(({ mark }) => mark);

    expect(await tool.execute({ mark: { "The plan": "chosen" } })).toBe(
      'Marked: the keeper reads "chosen" on "The plan".',
    );
    expect(marks()).toEqual(["chosen"]);
    expect(await tool.execute({ mark: { [plan.id]: "" } })).toBe(
      'Marked: "The plan" carries no mark now.',
    );
    expect(marks()).toEqual([undefined]);
    expect(await tool.execute({ mark: { "No such pane": "chosen" } })).toBe(
      'Not arranged: mark names "No such pane", and nothing you set out is out as that; shown lists what is out.',
    );
    expect(arranged).toEqual([]);
    expect(changed).toEqual([]);
  });

  it("raises and lowers a signal in the keeper's words, moving nothing", async () => {
    const { tool, settings, arranged, setOut } = staged();
    setOut({ where: "outside" });
    const signals = () => settings.open().map(({ signal }) => signal);

    expect(await tool.execute({ signal: { "The plan": "needs you" } })).toBe(
      '"The plan" needs the keeper now: it is outlined in amber until they answer it. Nothing else moved.',
    );
    expect(signals()).toEqual(["needs-you"]);
    expect(await tool.execute({ signal: { "The plan": "waiting" } })).toBe(
      '"The plan" needs the keeper already (needs-you, the nearest signal to "waiting"). Nothing moved.',
    );
    expect(await tool.execute({ signal: { "The plan": null } })).toBe(
      '"The plan" no longer needs the keeper. Nothing else moved.',
    );
    expect(signals()).toEqual([undefined]);
    expect(await tool.execute({ signal: { "The plan": "off" } })).toBe(
      '"The plan" carries no signal, so there was nothing to lower. Nothing moved.',
    );
    expect(await tool.execute({ signal: { "No such pane": "critical" } })).toBe(
      'Not arranged: signal names "No such pane", and nothing you set out is out as that; shown lists what is out.',
    );
    expect(await tool.execute({ signal: { "The plan": "loud" } })).toBe(
      'Not arranged: signal is needs-you, critical or none, not "loud".',
    );
    expect(arranged).toEqual([]);
  });

  it("raises critical with why, which becomes the pane's why, and lowers it again", async () => {
    const { tool, settings, setOut } = staged();
    setOut({ where: "outside" });

    expect(await tool.execute({ signal: { "The plan": "critical" } })).toBe(
      'Not arranged: critical needs a reason: give why, one sentence the keeper reads on "The plan" saying what is wrong.',
    );
    expect(await tool.execute({ why: "The tests wait on you." })).toBe(
      "Not arranged: why goes with signal, as the sentence the keeper reads on a pane you raise; name the signal, or leave why out.",
    );
    expect(
      await tool.execute({ signal: { "The plan": "critical" }, why: "The plan lost its tests." }),
    ).toBe(
      '"The plan" is critical now: the keeper sees it outlined in red with your reason, and it stays out until they have seen it. Nothing else moved.',
    );
    expect(settings.open()[0]).toMatchObject({
      signal: "critical",
      why: "The plan lost its tests.",
      until: "seen",
    });
    expect(await tool.execute({ signal: { "The plan": "needs-you" } })).toBe(
      '"The plan" is no longer critical, and needs the keeper now, outlined in amber. Nothing else moved.',
    );
    expect(await tool.execute({ signal: { "The plan": null } })).toBe(
      '"The plan" no longer needs the keeper. Nothing else moved.',
    );
  });

  it("signals in the same call that arranges, and says when the signal was refused", async () => {
    const { tool, setOut, answers } = staged();
    const plan = setOut({ where: "outside" });

    const answering = tool.execute({
      seats: { "The plan": "center" },
      signal: { "The plan": "critical" },
      why: "Lost.",
    });
    await answers(
      [{ id: plan.id, where: "outside", seat: { x: 3, y: 3, w: 6, h: 6 }, by: "creature" }],
      "",
    );
    expect(await answering).toBe(
      `Arranged 1 pane in the seats you composed. Outside now: "The plan" (${plan.id}) in the center. "The plan" is critical now: the keeper sees it outlined in red with your reason, and it stays out until they have seen it.`,
    );
  });

  it("says which panes it seated, which stayed, what now overlaps and the mood it moved with", async () => {
    const { tool, setOut, answers } = staged();
    const plan = setOut({ where: "outside" });
    const notes = setOut({ what: { kind: "note", ref: "Three things." }, where: "outside" });

    const answering = tool.execute({ seats: { "The plan": "left-two-thirds" }, mood: "festive" });
    await answers(
      [
        { id: plan.id, where: "outside", seat: { x: 0, y: 0, w: 8, h: 12 }, by: "creature" },
        { id: notes.id, where: "outside", seat: { x: 6, y: 0, w: 6, h: 6 }, by: "creature" },
      ],
      "",
    );

    expect(await answering).toBe(
      `Seated 1 pane where you composed, moving playfully, the nearest mood to "festive"; the other 1 stays where it stood. Outside now: "The plan" (${plan.id}) in the left two thirds; "Three things." (${notes.id}) in the top right. Overlapping now: "The plan" with "Three things.".`,
    );
  });

  it("sends the arrangement, waits for the console's report of it, and says where everything now stands", async () => {
    const { tool, arranged, setOut, answers } = staged();
    const plan = setOut({ where: "outside" });
    const notes = setOut({ what: { kind: "note", ref: "Three things." } });

    const answering = tool.execute({
      panes: [plan.id, notes.id],
      shape: "lead-and-stack",
      lead: plan.id,
    });
    await answers(
      [
        { id: plan.id, where: "outside", seat: { x: 0, y: 0, w: 8, h: 12 }, by: "creature" },
        { id: notes.id, where: "outside", seat: { x: 8, y: 0, w: 4, h: 6 }, by: "creature" },
      ],
      "The plan leads on the left;\nthe note stands beside it.",
    );

    expect(await answering).toBe(
      `Arranged 2 panes as lead-and-stack. Outside now: "The plan" (${plan.id}) in the left two thirds; "Three things." (${notes.id}) in columns 8 to 12, rows 0 to 6. The console says: The plan leads on the left; the note stands beside it.`,
    );
    expect(arranged).toEqual([
      expect.objectContaining({
        panes: [plan.id, notes.id],
        shape: "lead-and-stack",
        lead: plan.id,
      }),
    ]);
  });

  it('takes panes "all" as everything still out, beside the conversation too, and says what the console put back', async () => {
    const { tool, arranged, setOut, answers } = staged();
    const plan = setOut({ where: "outside" });
    const card = setOut({ what: { kind: "note", ref: "Three things." } });
    const extra = setOut({ what: { kind: "note", ref: "One more." } });

    const answering = tool.execute({ panes: "all", shape: "grid" });
    await answers(
      [
        { id: plan.id, where: "outside", seat: { x: 0, y: 0, w: 6, h: 12 }, by: "creature" },
        { id: card.id, where: "outside", seat: { x: 6, y: 0, w: 6, h: 12 }, by: "creature" },
        { id: extra.id, where: "beside", by: "console", note: "no room outside" },
      ],
      "",
    );

    expect(await answering).toBe(
      `Arranged 3 panes as grid. Outside now: "The plan" (${plan.id}) in the left half; "Three things." (${card.id}) in the right half. Back beside the conversation as a card (no room outside): "One more." (${extra.id}). Name it in arrange to set it out again.`,
    );
    expect(arranged).toEqual([
      expect.objectContaining({ panes: [plan.id, card.id, extra.id], shape: "grid" }),
    ]);
  });

  it("says the arrangement was asked for when the console has not answered in a second and a half", async () => {
    const { tool, arranged, setOut, unanswered } = staged();
    const plan = setOut({ where: "outside" });

    const answering = tool.execute({ relation: "notes" });
    await unanswered();

    expect(await answering).toBe(
      "Asked: the arrangement of 1 pane went to the console, which has not answered yet. shown will tell where things stand.",
    );
    expect(arranged).toEqual([expect.objectContaining({ panes: [plan.id], relation: "notes" })]);
  });

  it("takes shapes, relations, seats, the reach and the mood in the words a model reaches for", async () => {
    const { tool, arranged, setOut, unanswered } = staged();
    const plan = setOut({ where: "outside" });
    const diff = setOut({ what: { kind: "diff", ref: "cs-41" }, where: "outside" });
    const first = tool.execute({ shape: "Lead and Cards", over: "whole display", mood: "Lively" });
    await unanswered();
    await first;

    await tool.execute({ relation: "options" });
    await tool.execute({
      seats: [
        { id: "the plan", seat: "left 2/3" },
        { id: diff.id, seat: "right third" },
      ],
    });
    await tool.execute({ seats: { [plan.id]: "top", "cs-41": { x: 0, y: 6, w: 12, h: 6 } } });

    expect(
      arranged.map(({ shape, relation, seats, over, mood }) => ({
        shape,
        relation,
        seats,
        over,
        mood,
      })),
    ).toEqual([
      { shape: "lead-and-cards", over: "display", mood: "playful" },
      { relation: "alternatives" },
      {
        seats: [
          { id: plan.id, seat: { x: 0, y: 0, w: 8, h: 12 } },
          { id: diff.id, seat: { x: 8, y: 0, w: 4, h: 12 } },
        ],
      },
      {
        seats: [
          { id: plan.id, seat: { x: 0, y: 0, w: 12, h: 6 } },
          { id: diff.id, seat: { x: 0, y: 6, w: 12, h: 6 } },
        ],
      },
    ]);
  });

  it("answers what it cannot do with the limit and what would work, and sends nothing", async () => {
    const { tool, arranged, setOut } = staged();
    const plan = setOut({ where: "outside" });
    const yours = `what you have out is "The plan" (${plan.id})`;
    const refused: ReadonlyArray<[Record<string, unknown>, string]> = [
      [
        { shape: "spiral" },
        'shape is grid, columns, rows, lead-and-cards, lead-and-stack, split or board, not "spiral"',
      ],
      [{ relation: "rivals" }, 'relation is sequence, alternatives, tasks or notes, not "rivals"'],
      [{ over: "moon" }, 'over is room or display, not "moon"'],
      [
        { seats: [{ id: plan.id, seat: "columns 6 to 14" }] },
        "x 6 + w 8 is 14, past the stage's 12 columns; the nearest seat that fits is the right half",
      ],
      [{ panes: ["nope"] }, `nothing you set out is out as "nope"; ${yours}`],
      [
        { shape: "grid", relation: "tasks" },
        "shape, relation and seats are three ways to ask for one arrangement; give one of them, or none and the console chooses",
      ],
    ];

    for (const [args, why] of refused) {
      expect(await tool.execute(args)).toBe(`Not arranged: ${why}.`);
    }
    expect(arranged).toEqual([]);
  });
});
