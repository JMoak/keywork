import { strict as assert } from "node:assert";
import { headline } from "../../../packages/tui/src/index.ts";
import type { Scenario, Stage } from "../scenario.ts";

const tier2 = { glyphTier: 2 as const, nerdFont: false };

function rungLine(width: number): { face: string; line: string } {
  const set = headline("session-1", { width, rows: 20, glyphs: tier2 });
  return { face: set.face, line: (set.lines[0] ?? "").trimEnd() };
}

const rungs = [
  { screen: 75, width: 34, face: "stroke", step: "ladder-stroke" },
  { screen: 63, width: 28, face: "half-block", step: "ladder-half-block" },
  { screen: 55, width: 24, face: "quadrant", step: "ladder-quadrant" },
  { screen: 43, width: 18, face: "caps", step: "ladder-caps" },
] as const;

export const mastheadLadder: Scenario = {
  name: "masthead-ladder",
  description:
    "C74 fit ladder: the same title at descending widths engages each masthead rung down to caps",
  size: { width: 75, height: 20 },
  turns: [],
  run: async (stage: Stage) => {
    await stage.settle();
    await stage.press("ctrl+p");
    await stage.type("session tree");
    await stage.press("enter");
    await stage.press("ctrl+k", "x", "escape");
    await stage.press("ctrl+k", "s", "escape");
    await stage.settle();
    for (const rung of rungs) {
      const expected = rungLine(rung.width);
      assert.equal(expected.face, rung.face, `width ${rung.width} engages the ${rung.face} rung`);
      await stage.resize(rung.screen, 20);
      await stage.settle();
      const frame = await stage.capture(rung.step);
      assert.ok(
        frame.includes(expected.line),
        `the unfocused pane sets its title in the ${rung.face} face at ${rung.screen} columns`,
      );
    }
    await stage.quit();
  },
  goldens: rungs.map((rung) => rung.step),
};
