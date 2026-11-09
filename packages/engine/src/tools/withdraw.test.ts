import { describe, expect, it } from "vitest";
import { mutatingToolNames } from "../mutations.ts";
import { FakeClock } from "../routines/testing.ts";
import type { ShowEvents, ShowEventType } from "../show/setting.ts";
import { SettingStore, type ShowProposal } from "../show/store.ts";
import type { ShowTarget } from "./show.ts";
import { withdrawTool, withdrawToolName } from "./withdraw.ts";

const t0 = Date.parse("2026-11-08T09:00:00Z");

interface Emitted {
  sessionId: string;
  type: ShowEventType;
  payload: ShowEvents[ShowEventType];
}

function seated(creature: string | null = "wren") {
  const emitted: Emitted[] = [];
  const settings = new SettingStore({
    clock: new FakeClock(t0),
    emit: (sessionId, type, payload) => emitted.push({ sessionId, type, payload }),
  });
  const target: ShowTarget = { creature, sessionId: "s1", settings: () => settings };
  const setOut = (overrides: Partial<ShowProposal> = {}) => {
    const outcome = settings.propose(proposal(creature, overrides));
    if ("refused" in outcome) throw new Error(outcome.error);
    return outcome.setting;
  };
  return { tool: withdrawTool(target), settings, emitted, setOut };
}

function proposal(creature: string | null, overrides: Partial<ShowProposal>): ShowProposal {
  return {
    creature,
    sessionId: "s1",
    what: { kind: "note", ref: "Lunch at noon." },
    rung: "card",
    why: "A reminder.",
    until: "seen",
    from: null,
    origin: "creature",
    ...overrides,
  };
}

describe("the withdraw tool", () => {
  it("takes back what this seat set out, as the creature on the existing event", async () => {
    const { tool, settings, emitted, setOut } = seated();
    const setting = setOut();
    const before = emitted.length;

    const said = await tool.execute({ id: setting.id });

    expect(said).toBe(
      `Withdrawn: ${setting.id} has left the yard, and what grew from it stays out.`,
    );
    expect(settings.open()).toEqual([]);
    expect(emitted.slice(before)).toEqual([
      {
        sessionId: "s1",
        type: "show.settled",
        payload: { id: setting.id, outcome: "withdrawn", by: "creature" },
      },
    ]);
  });

  it("works for a thread with no creature, on its own settings", async () => {
    const { tool, settings, setOut } = seated(null);
    const setting = setOut();
    await tool.execute({ id: setting.id });
    expect(settings.open()).toEqual([]);
  });

  it("leaves what grew from it out", async () => {
    const { tool, settings, setOut } = seated();
    const parent = setOut({ what: { kind: "diff", ref: "cs-41" } });
    const child = setOut({ from: parent.id, what: { kind: "file", ref: "a.ts" } });

    await tool.execute({ id: parent.id });

    expect(settings.open()).toEqual([child]);
  });

  it("refuses what the keeper pinned, in words, and leaves it out", async () => {
    const { tool, settings, setOut } = seated();
    const setting = setOut();
    settings.answer(setting.id, "pinned");

    expect(await tool.execute({ id: setting.id })).toBe(
      `Not withdrawn: the keeper pinned ${setting.id}, so it stays until they let it go.`,
    );
    expect(settings.open()).toEqual([{ ...setting, state: "pinned" }]);
  });

  it("refuses what the keeper opened, pinned or not", async () => {
    const { tool, settings, setOut } = seated();
    const parent = setOut({ what: { kind: "diff", ref: "cs-41" } });
    const opened = await settings.keeperOpens({
      what: { kind: "url", ref: "https://example.com" },
      from: parent.id,
      rung: "unfold",
    });
    if ("refused" in opened) throw new Error(opened.error);
    const { id } = opened.setting;

    expect(await tool.execute({ id })).toBe(
      `Not withdrawn: the keeper opened ${id} themselves, so it is theirs to put away.`,
    );
    settings.answer(id, "pinned");
    expect(await tool.execute({ id })).toBe(
      `Not withdrawn: the keeper opened ${id} themselves, so it is theirs to put away.`,
    );
    expect(settings.open().map(({ id: out }) => out)).toEqual([parent.id, id]);
  });

  it("refuses what is not its own, without saying whose it is", async () => {
    const { tool, settings, setOut } = seated();
    const hals = settings.propose(proposal("hal", { sessionId: "s2" }));
    if ("refused" in hals) throw new Error(hals.error);

    for (const id of [hals.setting.id, "unknown"]) {
      expect(await tool.execute({ id })).toBe(
        `Not withdrawn: nothing you set out is out with the id ${id}; shown lists what is out.`,
      );
    }
    expect(settings.open()).toEqual([hals.setting]);
    setOut();
  });

  it("refuses an id already settled, the same way", async () => {
    const { tool, settings, setOut } = seated();
    const setting = setOut();
    settings.answer(setting.id, "seen");

    expect(await tool.execute({ id: setting.id })).toBe(
      `Not withdrawn: nothing you set out is out with the id ${setting.id}; shown lists what is out.`,
    );
  });

  it("takes back, from any session of the same creature, what the creature set out", async () => {
    const { tool, settings } = seated();
    const fromOtherThread = settings.propose(proposal("wren", { sessionId: "thread-b" }));
    if ("refused" in fromOtherThread) throw new Error(fromOtherThread.error);

    await tool.execute({ id: fromOtherThread.setting.id });

    expect(settings.open()).toEqual([]);
  });

  it("answers when no keeper surface takes settings", async () => {
    const tool = withdrawTool({ creature: "wren", sessionId: "s1", settings: () => undefined });
    expect(await tool.execute({ id: "x" })).toBe(
      "Not withdrawn: no keeper surface takes settings here.",
    );
  });

  it("is IDE control that asks for no permission and takes one id", async () => {
    const { tool } = seated();
    expect(tool.name).toBe(withdrawToolName);
    expect(tool.description).toContain("never the computer");
    expect(tool.mutates).toBeUndefined();
    expect(mutatingToolNames.has(tool.name)).toBe(false);
    expect(tool.parameters).toMatchObject({ required: ["id"] });
    for (const args of [
      {},
      { id: "" },
      { id: "   " },
      { id: "x".repeat(129) },
      { id: "x", extra: 1 },
    ]) {
      await expect(tool.execute(args)).rejects.toThrow();
    }
  });
});
