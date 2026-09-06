import { strict as assert } from "node:assert";
import { curatedTips } from "../../../packages/tui/src/index.ts";
import { occurrences } from "../frame-queries.ts";
import type { Scenario } from "../scenario.ts";

const frozenClock = (): number => Date.parse("2026-08-22T12:00:00.000Z");

const anyTip = new RegExp(
  curatedTips.map((tip) => tip.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
);

export const statusTips: Scenario = {
  name: "status-tips",
  description:
    "FR5.15: the quiet status bar rotates one tip for a feature the workspace has not used yet, and the idle main offers one too",
  size: { width: 110, height: 12 },
  turns: [],
  app: { tips: "on", clock: frozenClock },
  goldens: ["tip", "idle-main-tip"],
  run: async (stage) => {
    await stage.settle();
    const frame = await stage.until(anyTip);
    assert.ok(frame.includes("keywork e2e · "), "the tip rides the quiet status tail");
    await stage.capture("tip");

    await stage.type("/exit");
    await stage.press("enter");
    await stage.settle();
    const idleFrame = await stage.until("· main ·");
    const tipText = idleFrame.match(anyTip)?.[0];
    assert.ok(tipText !== undefined, "a tip stays eligible with the main area idle");
    assert.ok(
      idleFrame.includes("ctrl+k s starts a session here"),
      "the tip never replaces the idle-main hints",
    );
    assert.equal(
      occurrences(idleFrame, tipText),
      2,
      "the tip rides both the status tail and the idle-main panel",
    );
    await stage.capture("idle-main-tip");
    await stage.quit();
  },
};
