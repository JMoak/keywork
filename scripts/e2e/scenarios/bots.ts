import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { textTurn } from "../../../packages/engine/src/index.ts";
import type { Scenario } from "../scenario.ts";

const scout = "---\ndescription: reads before writing\ntools: [read]\n---\nYou are the scout.\n";
const reviewer = "---\ndescription: careful reviewer\nsigil: R\nlearning: off\n---\nReview only.\n";

export const botsTour: Scenario = {
  name: "bots-tour",
  description:
    "C67: /bot opens the picker (roster with sigils, purpose, use; + new bot) → enter opens a pane bound to the bot → /bot-switch rebinds the focused pane with a sigil + name notice → /bot-new walks purpose · name · scope and writes bots/<slug>/bot.md",
  size: { width: 140, height: 36 },
  files: {
    ".keywork/workspace.json": `${JSON.stringify({ name: "bots-e2e" })}\n`,
    ".keywork/bots/scout/bot.md": scout,
    ".keywork/bots/reviewer/bot.md": reviewer,
  },
  turns: [textTurn("as you wish")],
  run: async (stage) => {
    await stage.settle();
    await stage.type("/bot");
    await stage.press("enter");
    const picker = await stage.until("+ new bot");
    assert.ok(picker.includes("S scout · reads before writing · no sessions"), "scout row");
    assert.ok(picker.includes("R reviewer · careful reviewer · no sessions"), "reviewer row");
    await stage.capture("bot-picker");

    await stage.type("reviewer");
    await stage.press("enter");
    await stage.settle();
    await stage.until("session-2");
    await stage.capture("bot-pane-opened");

    await stage.type("/bot-switch scout");
    await stage.press("enter");
    await stage.until("bot → S scout");
    await stage.capture("bot-switched");

    await stage.type("/bot-new");
    await stage.press("enter");
    await stage.until("purpose  › ▌");
    await stage.type("hunts for missing tests");
    await stage.press("enter");
    await stage.until("name     › ▌");
    await stage.type("test-hawk");
    await stage.press("enter");
    const scopeRow = await stage.until("enter creates · ← → switch · esc back");
    assert.ok(scopeRow.includes("scope    › project  global"), "scope row defaults to project");
    await stage.capture("bot-new");
    await stage.press("enter");
    await stage.until("bot → T test-hawk · new");
    assert.ok(
      existsSync(join(stage.workspaceDir, ".keywork", "bots", "test-hawk", "bot.md")),
      "the creation flow wrote bots/test-hawk/bot.md under the project",
    );
    await stage.settle();
    await stage.until("session-3");
    await stage.capture("bot-created");
  },
};

export const botsTourAscii: Scenario = {
  ...botsTour,
  name: "bots-tour-ascii",
  description: "C67 at glyph tier 0: the bot picker and creation flow stay legible without glyphs",
  glyphs: { glyphTier: 0, nerdFont: false },
};
