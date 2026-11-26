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

    expect(said).toBe(`Withdrawn: ${setting.id} has gone back to your workshop.`);
    expect(settings.open()).toEqual([]);
    expect(emitted.slice(before)).toEqual([
      {
        sessionId: "s1",
        type: "show.settled",
        payload: { id: setting.id, outcome: "withdrawn", by: "creature" },
      },
    ]);
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

  it("refuses a critical an agent raised, and takes back one this seat raised", async () => {
    const { tool, settings, setOut } = seated();
    const agents = setOut({ signal: "critical", agent: { name: "codex" } });
    const own = setOut({ what: { kind: "note", ref: "Disk full." }, signal: "critical" });

    expect(await tool.execute({ id: agents.id })).toBe(
      'Not withdrawn: "Lunch at noon." is critical, raised by codex, and only it or the keeper may lower it.',
    );
    expect(await tool.execute({ id: own.id })).toMatch(/^Withdrawn: /);
    expect(settings.open().map(({ id }) => id)).toEqual([agents.id]);
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

  it("takes back, from any session of the same creature, what the creature set out", async () => {
    const { tool, settings } = seated();
    const fromOtherThread = settings.propose(proposal("wren", { sessionId: "thread-b" }));
    if ("refused" in fromOtherThread) throw new Error(fromOtherThread.error);

    await tool.execute({ id: fromOtherThread.setting.id });

    expect(settings.open()).toEqual([]);
  });

  it("takes back by title, several at once, and everything but what except names", async () => {
    const { tool, settings, setOut } = seated();
    const note = (title: string) => setOut({ what: { kind: "note", ref: `${title}.`, title } });
    const [plan, risks, tests, calls] = ["Plan", "Risks", "Tests", "On call"].map(note);

    expect(await tool.execute({ id: "risks" })).toBe(
      `Withdrawn: ${risks?.id} has gone back to your workshop.`,
    );
    expect(await tool.execute({ id: ["Tests", "Nothing like it"] })).toBe(
      `Withdrawn 1: "Tests" (${tests?.id}) has gone back to your workshop. Not withdrawn: nothing you set out is out with the id Nothing like it; shown lists what is out. Still out: "Plan" (${plan?.id}) and "On call" (${calls?.id}).`,
    );
    expect(await tool.execute({ id: "all", except: "Plan" })).toBe(
      `Withdrawn 1: "On call" (${calls?.id}) has gone back to your workshop. Still out: "Plan" (${plan?.id}).`,
    );
    expect(settings.open().map(({ id }) => id)).toEqual([plan?.id]);
  });

  it("names what grew from it and stays out, and only then", async () => {
    const { tool, setOut } = seated();
    const parent = setOut({ what: { kind: "diff", ref: "cs-41" } });
    const child = setOut({ from: parent.id, what: { kind: "file", ref: "a.ts" } });

    expect(await tool.execute({ id: parent.id })).toBe(
      `Withdrawn: ${parent.id} has gone back to your workshop. What grew from it stays out: "a.ts" (${child.id}).`,
    );
  });

  it("takes back a note by the id it had before it was replaced", async () => {
    const { tool, settings, setOut } = seated();
    const first = setOut({ what: { kind: "note", ref: "One.", title: "Plan" } });
    const second = setOut({ what: { kind: "note", ref: "Two.", title: "Plan" } });

    expect(await tool.execute({ id: first.id })).toBe(
      `Withdrawn: ${second.id} has gone back to your workshop.`,
    );
    expect(settings.open()).toEqual([]);
  });

  it("says so when two settings share the title it was given", async () => {
    const { tool, settings, setOut } = seated();
    const one = setOut({ what: { kind: "file", ref: "a.md", title: "Plan" } });
    const other = setOut({ what: { kind: "file", ref: "b.md", title: "Plan" } });

    expect(await tool.execute({ id: "Plan" })).toBe(
      `Not withdrawn: 2 of your settings are called "Plan", so name the one you mean by its id: ${one.id} or ${other.id}.`,
    );
    expect(settings.open()).toHaveLength(2);
  });

  it("takes nothing back when except names something that is not out", async () => {
    const { tool, settings, setOut } = seated();
    setOut({ what: { kind: "note", ref: "One.", title: "One" } });
    setOut({ what: { kind: "note", ref: "Two.", title: "Two" } });

    expect(await tool.execute({ id: "all", except: "Three" })).toBe(
      'Not withdrawn: except names "Three", and nothing you set out is out as that, so nothing was taken back; shown lists what is out.',
    );
    expect(settings.open()).toHaveLength(2);
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
