import { describe, expect, it } from "vitest";
import { type BotPickerRow, botPickerOver } from "./bot-picker.ts";
import type { BotSummary } from "./bots.ts";

const scout: BotSummary = {
  name: "scout",
  sigil: "S",
  source: "project",
  description: "reads before writing",
  sessions: 2,
  lastUsed: "2026-09-01T09:00:00.000Z",
};
const reviewer: BotSummary = {
  name: "reviewer",
  sigil: "⚖",
  source: "user",
  sessions: 0,
};
const hawk: BotSummary = {
  name: "test-hawk",
  sigil: "T",
  source: "project",
  description: "hunts for missing tests",
  sessions: 5,
  lastUsed: "2026-09-02T09:00:00.000Z",
};

function names(rows: readonly BotPickerRow[]): string[] {
  return rows.map((row) => (row.kind === "bot" ? row.bot.name : row.kind));
}

describe("botPickerOver", () => {
  it("lists the most recently used bots first, never-used ones last, then the new-bot row", () => {
    const picker = botPickerOver([reviewer, scout, hawk], undefined);
    expect(names(picker.rows())).toEqual(["test-hawk", "scout", "reviewer", "new"]);
  });

  it("matches on description as well as name and swaps the new-bot row for a create row", () => {
    const picker = botPickerOver([hawk, scout, reviewer], undefined);
    picker.retype("tests");
    expect(names(picker.rows())).toEqual(["test-hawk", "create"]);
  });

  it("offers to create a fresh slug, but never a taken or malformed one", () => {
    const picker = botPickerOver([scout], undefined);
    picker.retype("critic");
    expect(picker.rows()).toEqual([{ kind: "create", slug: "critic" }]);
    picker.retype("scout");
    expect(picker.rows().filter((row) => row.kind === "create")).toEqual([]);
    picker.retype("Not A Slug");
    expect(picker.rows()).toEqual([]);
  });
});
