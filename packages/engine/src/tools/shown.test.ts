import { describe, expect, it } from "vitest";
import { mutatingToolNames } from "../mutations.ts";
import { FakeClock } from "../routines/testing.ts";
import { SettingStore, type ShowProposal } from "../show/store.ts";
import { type ShowTarget, showTool } from "./show.ts";
import { shownTool, shownToolName } from "./shown.ts";

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
  it("says so plainly when nothing is out", async () => {
    const { tool } = seated();
    expect(await tool.execute({})).toBe("Nothing is out beside this conversation.");
  });

  it("says so plainly when no keeper surface takes settings", async () => {
    const tool = shownTool({ creature: "wren", sessionId: "s1", settings: () => undefined });
    expect(await tool.execute({})).toBe(
      "Nothing to list: no keeper surface takes settings here, so nothing can be set out.",
    );
  });

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
      },
    ]);
  });

  it("names the size only when one was named", async () => {
    const { tool, settings } = seated();
    settings.propose(proposal({ size: "working" }));
    settings.propose(proposal({ what: { kind: "note", ref: "n" } }));

    const [, sized, unsized] = (await tool.execute({})).split("\n");

    expect(JSON.parse(sized ?? "")).toMatchObject({ size: "working" });
    expect(JSON.parse(unsized ?? "")).not.toHaveProperty("size");
  });

  it("counts one setting in the singular", async () => {
    const { tool, settings } = seated();
    settings.propose(proposal());
    expect((await tool.execute({})).split("\n")[0]).toBe(
      "1 setting is out beside this conversation, oldest first, one JSON object to a line:",
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

  it("takes no arguments and asks for no permission", async () => {
    const { tool } = seated();
    expect(tool.name).toBe(shownToolName);
    expect(tool.parameters).toMatchObject({ additionalProperties: false });
    await expect(tool.execute({ id: "x" })).rejects.toThrow();
    expect(tool.mutates).toBeUndefined();
    expect(mutatingToolNames.has(tool.name)).toBe(false);
    expect(tool.description).toContain("never the computer");
  });
});
