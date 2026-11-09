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
    expect(tool.parameters).toMatchObject({ required: ["what", "why"] });
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
      required: ["what", "why"],
      properties: { from: expect.objectContaining({ description: expect.any(String) }) },
    });
  });
});
