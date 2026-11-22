import { describe, expect, it } from "vitest";
import { FakeClock } from "../routines/testing.ts";
import { SettingStore, type ShowProposal } from "../show/store.ts";
import { type ShowTarget, showTool } from "./show.ts";
import { shownTool } from "./shown.ts";

const t0 = Date.parse("2026-11-08T09:00:00Z");

function seated(creature: string | null = "wren") {
  const settings = new SettingStore({ clock: new FakeClock(t0), emit: () => undefined });
  const target: ShowTarget = { creature, sessionId: "s1", settings: () => settings };
  return { tool: shownTool(target), show: showTool(target), settings, target };
}

function proposal(overrides: Partial<ShowProposal> = {}): ShowProposal {
  return {
    creature: "wren",
    sessionId: "s1",
    what: { kind: "file", ref: "docs/plan.md", title: "The plan" },
    rung: "unfold",
    why: "The plan changed.",
    until: "seen",
    from: null,
    origin: "creature",
    ...overrides,
  };
}

describe("the shown tool", () => {
  it("lists what is out beside this conversation, whoever set it out, oldest first, one JSON object to a line", async () => {
    const { tool, settings } = seated();
    const diff = settings.propose(proposal({ what: { kind: "diff", ref: "cs-41" }, rung: "card" }));
    if ("refused" in diff) throw new Error(diff.error);
    settings.answer(diff.setting.id, "pinned");
    const opened = await settings.keeperOpens({
      what: { kind: "url", ref: "https://example.com" },
      from: diff.setting.id,
      rung: "unfold",
    });
    if ("refused" in opened) throw new Error(opened.error);

    const listed = (await tool.execute({})).split("\n");

    expect(listed[0]).toBe(
      "2 settings are out beside this conversation, oldest first, one JSON object to a line:",
    );
    expect(listed.slice(1).map((line) => JSON.parse(line))).toEqual([
      {
        id: diff.setting.id,
        what: { kind: "diff", ref: "cs-41" },
        rung: "card",
        why: "The plan changed.",
        state: "pinned",
        at: "2026-11-08T09:00:00.000Z",
        until: "seen",
        from: null,
        origin: "creature",
        where: "beside",
      },
      {
        id: opened.setting.id,
        what: { kind: "url", ref: "https://example.com" },
        rung: "unfold",
        why: "",
        state: "live",
        at: "2026-11-08T09:00:00.000Z",
        until: "seen",
        from: diff.setting.id,
        origin: "keeper",
        where: "beside",
      },
    ]);
  });

  it("tells where each thing stands, its seat in the words show takes, who put it there, and the stage once", async () => {
    const { tool, settings } = seated();
    const out = (overrides: Partial<ShowProposal>) => {
      const outcome = settings.propose(proposal(overrides));
      if ("refused" in outcome) throw new Error(outcome.error);
      return outcome.setting.id;
    };
    const lead = out({ seat: { x: 0, y: 0, w: 8, h: 12 }, weight: "lead" });
    const moved = out({ what: { kind: "note", ref: "a" }, where: "outside" });
    const inside = out({ what: { kind: "note", ref: "b" }, where: "outside" });
    out({ what: { kind: "note", ref: "c" } });
    out({ what: { kind: "note", ref: "d" }, seat: { x: 0, y: 0, w: 6, h: 6 } });
    await settings.placed("s1", {
      stage: { room: "beside", cardsAcross: 4, cardsDown: 3, consoleMaximised: false },
      placements: [
        { id: lead, where: "outside", seat: { x: 0, y: 0, w: 8, h: 12 }, by: "creature" },
        { id: moved, where: "outside", seat: { x: 8, y: 0, w: 4, h: 5 }, by: "keeper" },
        { id: inside, where: "inside", by: "keeper" },
      ],
    });

    const listed = (await tool.execute({})).split("\n");

    expect(listed[0]).toBe(
      "5 settings are out, 3 outside in windows of their own, oldest first, one JSON object to a line:",
    );
    expect(
      listed.slice(1, -1).map((line) => {
        const { where, seat, by, weight } = JSON.parse(line);
        return { where, seat, by, weight };
      }),
    ).toEqual([
      { where: "outside", seat: "left-two-thirds", by: "creature", weight: "lead" },
      { where: "outside", seat: "columns 8 to 12, rows 0 to 5", by: "keeper" },
      { where: "inside", by: "keeper" },
      { where: "beside" },
      { where: "outside", seat: "top-left" },
    ]);
    expect(listed.at(-1)).toBe(
      "The stage, where your windows outside stand, is the free room beside the console: the smallest seats fit 4 across and 3 down, and the console is not maximised.",
    );
  });

  it("shows a thread only its own when it has no creature, and a creature only its own", async () => {
    const plain = seated(null);
    plain.settings.propose(proposal({ creature: null }));
    plain.settings.propose(proposal({ creature: null, sessionId: "s2" }));
    plain.settings.propose(proposal({ creature: "hal", sessionId: "s1" }));
    expect((await plain.tool.execute({})).split("\n").slice(1)).toHaveLength(1);

    const wren = seated("wren");
    wren.settings.propose(proposal({ sessionId: "another-of-wren" }));
    wren.settings.propose(proposal({ creature: "hal" }));
    expect((await wren.tool.execute({})).split("\n").slice(1)).toHaveLength(1);
  });
});
