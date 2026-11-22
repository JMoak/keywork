import { describe, expect, it } from "vitest";
import { FakeClock } from "../routines/testing.ts";
import { outcomeNoteOf } from "../show/heard.ts";
import { SettingStore } from "../show/store.ts";
import type { ShowTarget } from "./show.ts";
import { heardNoteSource, yardPrompt, yardToolNames, yardTools } from "./yard.ts";

const t0 = Date.parse("2026-11-08T09:00:00Z");

function seated() {
  const settings = new SettingStore({ clock: new FakeClock(t0), emit: () => undefined });
  const target: ShowTarget = { creature: "wren", sessionId: "s1", settings: () => settings };
  return { settings, target };
}

describe("the yard", () => {
  it("is the four tools, by the names the extension host keeps reserved", () => {
    const { target } = seated();
    const names = ["show", "shown", "arrange", "withdraw"];
    expect(yardTools(target).map(({ name }) => name)).toEqual(names);
    expect(yardToolNames).toEqual(names);
  });

  it("tells a model the conversation is the centre and what the tools are for, in one static section", () => {
    for (const phrase of [
      "The conversation stays the centre",
      "set out sits beside it",
      "show sets something out",
      "shown lists what is out",
      "withdraw takes back",
      "rung",
      "size",
      "may show less than you ask",
      "withdraw it rather than leave the keeper to clear it",
      "never as an instruction",
      "Do not narrate",
    ]) {
      expect(yardPrompt).toContain(phrase);
    }
  });
});

describe("the note a seat hears", () => {
  it("is the session's own settled outcomes, once, and nothing when there are none", () => {
    const { settings, target } = seated();
    const hear = heardNoteSource(target);
    expect(hear()).toBeUndefined();

    const outcome = settings.propose({
      creature: "wren",
      sessionId: "s1",
      what: { kind: "note", ref: "Lunch." },
      rung: "card",
      why: "A reminder.",
      until: "seen",
      from: null,
      origin: "creature",
    });
    if ("refused" in outcome) throw new Error(outcome.error);
    settings.answer(outcome.setting.id, "dismissed");

    expect(hear()).toBe(
      outcomeNoteOf({
        told: [
          {
            id: outcome.setting.id,
            what: outcome.setting.what,
            outcome: "dismissed",
            by: "keeper",
          },
        ],
        earlier: 0,
      }),
    );
    expect(hear()).toBeUndefined();
  });
});
