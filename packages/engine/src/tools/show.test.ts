import { describe, expect, it } from "vitest";
import { mutatingToolNames } from "../mutations.ts";
import { FakeClock } from "../routines/testing.ts";
import type { ShowThread } from "../show/lineage.ts";
import type { Setting } from "../show/setting.ts";
import { SettingStore, type SettingStoreOptions } from "../show/store.ts";
import { type ShowTarget, showTool, showToolName } from "./show.ts";

const t0 = Date.parse("2026-11-08T09:00:00Z");

function seated(
  options: Pick<SettingStoreOptions, "hourlyLimit" | "threads"> & { creature?: string | null } = {},
) {
  const { creature = "wren", ...limits } = options;
  const proposed: Setting[] = [];
  const settings = new SettingStore({
    clock: new FakeClock(t0),
    emit: (_sessionId, type, payload) => {
      if (type === "show.proposed" && "setting" in payload) proposed.push(payload.setting);
    },
    ...limits,
  });
  const target: ShowTarget = { creature, sessionId: "s1", settings: () => settings };
  return { tool: showTool(target), settings, proposed };
}

const plan = { kind: "file", ref: "docs/plan.md" };

function growsFrom(setting: Setting | undefined): string {
  if (setting === undefined) throw new Error("nothing was set out");
  return `To set out what grows from it, name ${setting.id} as from.`;
}

describe("the show tool", () => {
  it("sets out a card on the creature's thread by default and says what the yard decides", async () => {
    const { tool, settings } = seated();

    const said = await tool.execute({ what: plan, why: "The plan you asked about changed." });

    expect(said).toBe(
      `Set out as a card; the yard decides whether it unfolds. It stays until the keeper has seen it. ${growsFrom(settings.open()[0])}`,
    );
    expect(settings.open()).toEqual([
      expect.objectContaining({
        creature: "wren",
        sessionId: "s1",
        what: plan,
        rung: "card",
        why: "The plan you asked about changed.",
        until: "seen",
        state: "live",
      }),
    ]);
  });

  it("carries the proposed rung, a title and when it goes, and says a repeat replaces", async () => {
    const { tool, proposed } = seated();

    expect(
      await tool.execute({
        what: { ...plan, title: "The plan" },
        rung: "unfold",
        why: "Read this before the call.",
        until: "rests",
      }),
    ).toBe(
      `Set out to unfold; the yard decides whether it unfolds or stays a card. It goes when this thread rests. ${growsFrom(proposed.at(-1))}`,
    );
    expect(
      await tool.execute({
        what: plan,
        rung: "stage",
        why: "Now it is final.",
        until: "2026-11-08T10:00:00-06:00",
      }),
    ).toBe(
      `Set out for the stage; only the keeper or a yard rule stages it, so the yard decides how it shows. It goes at 2026-11-08T10:00:00-06:00. It replaces what you set out for this before. ${growsFrom(proposed.at(-1))}`,
    );
    expect(
      await tool.execute({
        what: { kind: "note", ref: "Lunch at noon." },
        rung: "lantern",
        why: "A reminder.",
      }),
    ).toBe(
      `Set out as a lantern; the keeper looks when ready. It stays until the keeper has seen it. ${growsFrom(proposed.at(-1))}`,
    );
    expect(proposed.map(({ what, rung }) => ({ what, rung }))).toEqual([
      { what: { ...plan, title: "The plan" }, rung: "unfold" },
      { what: plan, rung: "stage" },
      { what: { kind: "note", ref: "Lunch at noon." }, rung: "lantern" },
    ]);
  });

  it("answers the hourly limit and a time gone by in words instead of setting out", async () => {
    const { tool, settings } = seated({ hourlyLimit: 1 });

    expect(await tool.execute({ what: plan, why: "One.", until: "2026-11-08T08:00:00Z" })).toBe(
      "Not set out: until 2026-11-08T08:00:00Z has already passed.",
    );
    await tool.execute({ what: plan, why: "One." });
    expect(
      await tool.execute({ what: { kind: "url", ref: "https://example.com" }, why: "Two." }),
    ).toBe(
      "Not set out: wren has set out 1 settings this hour, the most a creature may set out; try again later.",
    );
    expect(settings.open()).toHaveLength(1);
  });

  it("refuses with a sentence when no keeper surface takes settings", async () => {
    const tool = showTool({ creature: "wren", sessionId: "s1", settings: () => undefined });
    expect(await tool.execute({ what: plan, why: "Look." })).toBe(
      "Not set out: no keeper surface takes settings here; tell the keeper in words instead.",
    );
  });

  it("refuses arguments outside the wire shape", async () => {
    const { tool, settings } = seated();
    const refused = [
      { what: { kind: "image", ref: "a.png" }, why: "Look." },
      { what: { kind: "note", ref: "x".repeat(2_001) }, why: "Look." },
      { what: { ...plan, extra: true }, why: "Look." },
      { what: plan, why: "x".repeat(201) },
      { what: plan, why: "   " },
      { what: plan, why: "Look.", rung: "glyph" },
      { what: plan, why: "Look.", until: "tomorrow" },
      { what: plan, why: "Look.", until: "2026-11-08T10:00:00" },
      { what: plan, why: "Look.", focus: true },
    ];
    for (const args of refused) await expect(tool.execute(args)).rejects.toThrow();
    expect(settings.open()).toEqual([]);
    expect(tool.parameters).toMatchObject({ required: ["what"] });
  });

  it("keeps what a second showing of the same thing leaves out", async () => {
    const { tool, proposed } = seated();
    await tool.execute({
      what: { kind: "note", ref: "Lunch at noon.", title: "Lunch" },
      why: "So you can plan around it.",
      rung: "unfold",
      until: "rests",
      mark: "draft",
    });

    await tool.execute({ what: { kind: "note", ref: "Lunch at one.", title: "Lunch" } });

    expect(proposed.at(-1)).toMatchObject({
      what: { ref: "Lunch at one." },
      why: "So you can plan around it.",
      rung: "unfold",
      until: "rests",
      mark: "draft",
      replaces: proposed[0]?.id,
    });
  });

  it("takes a time from now, and says the mark the keeper reads", async () => {
    const { tool, proposed } = seated();

    expect(await tool.execute({ what: plan, until: "10 minutes", mark: "  needs   review " })).toBe(
      `Set out as a card; the yard decides whether it unfolds. It goes in 10 minutes, at 2026-11-08T09:10:00.000Z. The keeper reads "needs review" on it. ${growsFrom(proposed.at(-1))}`,
    );
    expect(proposed.at(-1)).toMatchObject({
      until: "2026-11-08T09:10:00.000Z",
      mark: "needs review",
    });
  });

  it("works for a session with no creature, which owns its settings and its hourly count", async () => {
    const { tool, settings } = seated({ creature: null, hourlyLimit: 1 });

    await tool.execute({ what: plan, why: "The plan you asked about changed." });
    expect(await tool.execute({ what: { kind: "note", ref: "Two." }, why: "Two." })).toBe(
      "Not set out: this thread has set out 1 settings this hour, the most a thread may set out; try again later.",
    );

    expect(settings.open()).toEqual([
      expect.objectContaining({ creature: null, sessionId: "s1", what: plan }),
    ]);
  });

  it("carries a named size onto the setting, and leaves it absent when none was named", async () => {
    const { tool, proposed } = seated();

    await tool.execute({ what: plan, why: "Read it.", rung: "unfold", size: "working" });
    await tool.execute({ what: { kind: "diff", ref: "cs-41" }, why: "The fix." });

    expect(proposed.map(({ size }) => size)).toEqual(["working", undefined]);
    expect(proposed[1]).not.toHaveProperty("size");
  });

  it("keeps a size that was named when a later call replaces the setting, unless it names another", async () => {
    const { tool, proposed } = seated();

    await tool.execute({ what: plan, why: "Read it.", rung: "unfold", size: "working" });
    await tool.execute({ what: plan, why: "It moved." });
    await tool.execute({ what: plan, why: "It moved again.", size: "readable" });

    expect(proposed.map(({ size }) => size)).toEqual(["working", "working", "readable"]);
  });

  it("refuses a size outside the wire shape", async () => {
    const { tool, settings } = seated();
    await expect(tool.execute({ what: plan, why: "Look.", size: 2 })).rejects.toThrow();
    expect(await tool.execute({ what: plan, why: "Look.", size: "huge" })).toBe(
      'Not set out: size is card, readable or working, not "huge".',
    );
    expect(settings.open()).toEqual([]);
  });

  it("says a size applies when it first opens, the yard may show less, and it cannot change", () => {
    const { tool } = seated();
    expect(tool.description).toContain("A size applies the first time the setting opens");
    expect(tool.description).toContain("the yard may still show less");
    expect(tool.description).toContain("it cannot be changed later");
    expect(tool.parameters).toMatchObject({ required: ["what"] });
  });

  it("is IDE control that asks for no permission", () => {
    const { tool } = seated();
    expect(tool.name).toBe(showToolName);
    expect(tool.description).toContain("never the computer");
    expect(tool.mutates).toBeUndefined();
    expect(mutatingToolNames.has(tool.name)).toBe(false);
  });
});

describe("the show tool's from", () => {
  const threads = async (sessionId: string): Promise<ShowThread | undefined> =>
    ({
      child: { creature: null, parent: "s1" },
      stranger: { creature: null, parent: null },
    })[sessionId];

  it("grows a setting from one it set out, named by the id its answer gave", async () => {
    const { tool, proposed } = seated();
    await tool.execute({ what: { kind: "diff", ref: "cs-41" }, why: "The fix is ready." });
    const diff = proposed[0];

    const said = await tool.execute({ what: plan, why: "The file it touches.", from: diff?.id });

    expect(said).toBe(
      `Set out as a card; the yard decides whether it unfolds. It stays until the keeper has seen it. ${growsFrom(proposed[1])}`,
    );
    expect(proposed.map(({ from, origin }) => ({ from, origin }))).toEqual([
      { from: null, origin: "creature" },
      { from: diff?.id, origin: "creature" },
    ]);
  });

  it("grows from this thread or a thread it delegated, and takes null as no from", async () => {
    const { tool, proposed } = seated({ threads });

    await tool.execute({ what: plan, why: "From here.", from: "s1" });
    await tool.execute({ what: { kind: "report", ref: "r1" }, why: "The child's.", from: "child" });
    await tool.execute({ what: { kind: "note", ref: "n" }, why: "Fresh.", from: null });

    expect(proposed.map(({ from }) => from)).toEqual(["s1", "child", null]);
  });

  it("keeps its place in the trail when it replaces what it set out before", async () => {
    const { tool, proposed } = seated();
    await tool.execute({ what: { kind: "diff", ref: "cs-41" }, why: "The fix." });
    await tool.execute({ what: plan, why: "The file.", from: proposed[0]?.id });

    await tool.execute({ what: plan, why: "The file changed again." });

    expect(proposed.map(({ from }) => from)).toEqual([null, proposed[0]?.id, proposed[0]?.id]);
  });

  it("answers a from out of sight with a sentence and sets nothing out", async () => {
    const { tool, settings } = seated({ threads });
    const hal = seated({ creature: "hal" });
    await hal.tool.execute({ what: plan, why: "Hal's." });

    for (const from of ["stranger", "unknown", hal.proposed[0]?.id ?? ""]) {
      expect(await tool.execute({ what: plan, why: "Look.", from })).toBe(
        `Not set out: nothing you may grow from has the id ${from}; name a setting you set out that is still out, or a thread of yours.`,
      );
    }
    expect(settings.open()).toEqual([]);
  });

  it("refuses a from outside the wire shape", async () => {
    const { tool, settings } = seated();
    for (const from of ["", "   ", "x".repeat(129), 7]) {
      await expect(tool.execute({ what: plan, why: "Look.", from })).rejects.toThrow();
    }
    expect(settings.open()).toEqual([]);
  });

  it("is described to the model as optional", () => {
    const { tool } = seated();
    expect(tool.description).toContain("Name from when it grows out of something already in view");
    expect(tool.parameters).toMatchObject({
      required: ["what"],
      properties: { from: expect.objectContaining({ description: expect.any(String) }) },
    });
  });
});

describe("the show tool outside", () => {
  const stage = { room: "beside", cardsAcross: 4, cardsDown: 3, consoleMaximised: false } as const;

  function staged() {
    const clock = new FakeClock(t0);
    const proposed: Setting[] = [];
    const settings = new SettingStore({
      clock,
      emit: (_sessionId, type, payload) => {
        if (type === "show.proposed" && "setting" in payload) proposed.push(payload.setting);
      },
    });
    const target: ShowTarget = { creature: "wren", sessionId: "s1", settings: () => settings };
    const unanswered = () => clock.advanceTo(clock.now() + 1_500, async () => undefined);
    const last = () => proposed.at(-1) as Setting;
    return { tool: showTool(target), settings, proposed, unanswered, last };
  }

  it("needs only what the thing is and where, and says where the console seated it", async () => {
    const { tool, settings, last } = staged();

    const answering = tool.execute({ what: plan, where: "outside" });
    const setting = last();
    await settings.placed("s1", {
      stage,
      placements: [
        { id: setting.id, where: "outside", seat: { x: 6, y: 0, w: 6, h: 12 }, by: "console" },
      ],
    });

    expect(await answering).toBe(
      `Set out outside in a window of its own, in the right half. It stays until the keeper has seen it. ${growsFrom(setting)}`,
    );
    expect(setting).toMatchObject({ what: plan, why: "", rung: "card", where: "outside" });
    expect(setting).not.toHaveProperty("seat");
  });

  it("takes a seat in the words a model reaches for, puts it outside, and carries weight and mood", async () => {
    const { tool, proposed, unanswered } = staged();

    const first = tool.execute({ what: plan, seat: "Upper Right", weight: "main", mood: "Gentle" });
    await unanswered();
    await first;
    await tool.execute({
      what: { kind: "diff", ref: "cs-41" },
      seat: "columns 4 to 8, rows 0 to 6",
    });
    await tool.execute({ what: { kind: "note", ref: "n" }, seat: { x: 0, y: 6, w: 12, h: 6 } });
    await tool.execute({ what: { kind: "url", ref: "u" }, where: "its own window", size: "small" });

    expect(
      proposed.map(({ where, seat, weight, mood, size }) => ({ where, seat, weight, mood, size })),
    ).toEqual([
      { where: "outside", seat: { x: 6, y: 0, w: 6, h: 6 }, weight: "lead", mood: "calm" },
      { where: "outside", seat: { x: 4, y: 0, w: 4, h: 6 } },
      { where: "outside", seat: { x: 0, y: 6, w: 12, h: 6 } },
      { where: "outside", size: "card" },
    ]);
  });

  it("says what it asked for when the console has not answered in a second and a half", async () => {
    const { tool, last, unanswered } = staged();

    const seated = tool.execute({ what: plan, seat: "left-half", until: "rests" });
    const first = last();
    await unanswered();

    expect(await seated).toBe(
      `Set out outside in a window of its own, asked for the left half; the console has not said where it stands yet, so shown will tell. It goes when this thread rests. ${growsFrom(first)}`,
    );
    expect(await tool.execute({ what: { kind: "note", ref: "n" }, where: "outside" })).toBe(
      `Set out outside in a window of its own; the console chooses its seat and has not said where yet, so shown will tell. It stays until the keeper has seen it. ${growsFrom(last())} Your other windows: "docs/plan.md" (${first.id}) asked for the left half, not yet reported by the console.`,
    );
  });

  it("says what the console corrected and where the creature's other windows stand", async () => {
    const { tool, settings, last } = staged();
    const first = tool.execute({ what: plan, seat: "full" });
    const full = last();
    const leftHalf = { id: full.id, where: "outside", seat: { x: 0, y: 0, w: 6, h: 12 } } as const;
    await settings.placed("s1", { stage, placements: [{ ...leftHalf, by: "console" }] });

    expect(await first).toBe(
      `Set out outside in a window of its own, in the left half. You asked for the whole stage, and the console corrected it. It stays until the keeper has seen it. ${growsFrom(full)}`,
    );

    const second = tool.execute({ what: { kind: "diff", ref: "cs-41" }, where: "outside" });
    const diff = last();
    await settings.placed("s1", {
      stage,
      placements: [
        { ...leftHalf, by: "keeper" },
        { id: diff.id, where: "outside", seat: { x: 6, y: 0, w: 6, h: 6 }, by: "console" },
      ],
    });

    expect(await second).toBe(
      `Set out outside in a window of its own, in the top right. It stays until the keeper has seen it. ${growsFrom(diff)} Your other windows: "docs/plan.md" (${full.id}) in the left half, placed by the keeper.`,
    );
  });

  it("answers a seat or a word it cannot place with what would work, and sets nothing out", async () => {
    const { tool, settings } = staged();
    const refused: ReadonlyArray<[Record<string, unknown>, string]> = [
      [
        { seat: { x: 8, y: 0, w: 6, h: 12 } },
        "x 8 + w 6 is 14, past the stage's 12 columns; the nearest seat that fits is the right third",
      ],
      [
        { seat: "the attic" },
        'no seat is called "the attic"; the nearest are full, center and left-third, or give lattice lines such as "columns 4 to 8, rows 0 to 6"',
      ],
      [
        { where: "beside", seat: "left-half" },
        "a seat is a place outside, so it cannot go with where beside; leave one of them out",
      ],
      [{ where: "upstairs" }, 'where is beside or outside, not "upstairs"'],
      [{ weight: "heavy" }, 'weight is lead, support or aside, not "heavy"'],
      [
        { mood: "angry" },
        'mood is calm, brisk, eager, playful, urgent, decisive or tentative, not "angry"',
      ],
    ];

    for (const [args, why] of refused) {
      expect(await tool.execute({ what: plan, ...args })).toBe(`Not set out: ${why}.`);
    }
    expect(settings.open()).toEqual([]);
  });

  it("answers the thirteenth thing outside with the limit and the way that stays open", async () => {
    const { tool, settings, unanswered } = staged();
    const first = tool.execute({ what: { kind: "note", ref: "note 0" }, where: "outside" });
    await unanswered();
    await first;
    for (let index = 1; index < 12; index += 1) {
      await tool.execute({ what: { kind: "note", ref: `note ${index}` }, where: "outside" });
    }

    expect(await tool.execute({ what: plan, where: "outside" })).toBe(
      "Not set out: 12 of your settings already stand outside, the most that may at once; withdraw one that has gone stale, or leave where out and this sets out beside the conversation.",
    );
    expect(await tool.execute({ what: plan })).toContain("Set out as a card");
    expect(settings.open()).toHaveLength(13);
  });

  it("says a second showing replaced the first in place, in the window it keeps", async () => {
    const { tool, settings, proposed } = staged();
    const note = (ref: string) => ({ what: { kind: "note", ref, title: "Budget" }, seat: "left" });
    const placedAt = (id: string) =>
      settings.placed("s1", {
        stage,
        placements: [{ id, where: "outside", seat: { x: 0, y: 0, w: 6, h: 12 }, by: "creature" }],
      });
    const first = tool.execute(note("About five thousand."));
    await placedAt((proposed[0] as Setting).id);
    await first;

    const second = tool.execute({ what: { kind: "note", ref: "5,700.", title: "Budget" } });
    const replacement = proposed[1] as Setting;
    await placedAt(replacement.id);

    expect(await second).toBe(
      `Replaced in place: what you set out for this before now reads as this. It keeps its window, in the left half. It stays until the keeper has seen it. ${growsFrom(replacement)}`,
    );
    expect(replacement).toMatchObject({ where: "outside", seat: { x: 0, y: 0, w: 6, h: 12 } });
  });

  it("sets out several things in one call, each in its own seat, and says where each stands", async () => {
    const { tool, settings, proposed } = staged();
    const note = (title: string, seat: string) => ({ kind: "note", ref: `${title}.`, title, seat });

    const answering = tool.execute({
      what: [note("Plan A", "left-half"), note("Plan B", "right quarter")],
      mood: "playful",
      mark: "draft",
    });
    const [a, b] = proposed as [Setting, Setting];
    await settings.placed("s1", {
      stage,
      placements: [
        { id: a.id, where: "outside", seat: { x: 0, y: 0, w: 6, h: 12 }, by: "creature" },
        { id: b.id, where: "outside", seat: { x: 9, y: 0, w: 3, h: 12 }, by: "creature" },
      ],
    });

    expect(await answering).toBe(
      `Set out 2: "Plan A" (${a.id}) in the left half; "Plan B" (${b.id}) in the right quarter. They arrived playfully. They stay until the keeper has seen them. Marked: "Plan A" as "draft"; "Plan B" as "draft". Name any of them by its title or its id in from, arrange or withdraw.`,
    );
    expect(proposed.map(({ mark, mood }) => [mark, mood])).toEqual([
      ["draft", "playful"],
      ["draft", "playful"],
    ]);
  });

  it("asks for a seat each when several things are given one seat, and sets nothing out", async () => {
    const { tool, settings } = staged();
    const things = [
      { kind: "note", ref: "One." },
      { kind: "note", ref: "Two." },
    ];

    expect(await tool.execute({ what: things, seat: "left-half" })).toBe(
      "Not set out: seat names one place, and you are setting out several things; give each thing its own seat inside what, or leave seats out and the console lays them out.",
    );
    expect(settings.open()).toEqual([]);
  });

  it("says how many of several were set out when a limit stops the rest", async () => {
    const { tool, settings, unanswered } = staged();
    const things = Array.from({ length: 12 }, (_, index) => ({ kind: "note", ref: `n${index}` }));
    const waiting = () => new Promise((resolve) => setTimeout(resolve, 0));
    const eleven = tool.execute({ what: things.slice(0, 11), where: "outside" });
    await waiting();
    await unanswered();
    await eleven;

    const said = tool.execute({
      what: [things[11], { kind: "note", ref: "one too many" }],
      where: "outside",
    });
    await waiting();
    await unanswered();

    expect(await said).toContain(
      "The next thing was not set out: 12 of your settings already stand outside, the most that may at once;",
    );
    expect(settings.open()).toHaveLength(12);
  });

  it("describes the place, the seat, the weight and the mood, and asks only for what the thing is", () => {
    const { tool } = staged();
    expect(tool.parameters).toMatchObject({
      required: ["what"],
      properties: {
        where: { enum: ["beside", "outside"] },
        seat: { anyOf: [{ type: "string" }, { type: "object", required: ["x", "y", "w", "h"] }] },
        weight: { enum: ["lead", "support", "aside"] },
        mood: {
          enum: ["calm", "brisk", "eager", "playful", "urgent", "decisive", "tentative"],
        },
        size: { enum: ["card", "readable", "working"] },
      },
    });
    expect(tool.description).toContain("never takes focus");
  });
});
