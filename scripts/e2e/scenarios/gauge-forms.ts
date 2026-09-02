import { textTurn } from "../../../packages/engine/src/index.ts";
import type { GaugeStyle } from "../../../packages/tui/src/index.ts";
import type { Scenario } from "../scenario.ts";

const gaugeWindow = 2_000;
const fillCount = 5;

const fillTurns = Array.from({ length: fillCount }, (_, at) =>
  textTurn(`${"keep the budget honest across every turn. ".repeat(45)}reply ${at + 1} done.`),
);

function gaugeScenario(style: GaugeStyle, fills: readonly number[]): Scenario {
  return {
    name: `gauge-${style}`,
    description: `C55 gauge candidate "${style}" rendered at a progression of context fills`,
    size: { width: 110, height: 24 },
    contextWindow: gaugeWindow,
    turns: fillTurns,
    app: { gauge: style, afterTurn: async () => undefined },
    goldens: fills.map((fill) => `fill-${fill}`),
    run: async (stage) => {
      const gaugeLeadsTheHeader = / session-1 · [░▒▓█▖▌▙·]/;
      await stage.settle();
      await stage.press("ctrl+p");
      await stage.type("session tree");
      await stage.press("enter");
      await stage.press("ctrl+k", "x", "escape");
      await stage.settle();
      for (let turn = 1; turn <= fillCount; turn += 1) {
        await stage.type(`step ${turn}`);
        await stage.press("enter");
        await stage.until(`reply ${turn} done.`);
        await stage.until(gaugeLeadsTheHeader);
        await stage.settle();
        if (fills.includes(turn)) await stage.capture(`fill-${turn}`);
      }
      await stage.quit();
    },
  };
}

const everyFill = [1, 2, 3, 4, 5];

export const gaugeRamp = gaugeScenario("ramp", everyFill);
export const gaugeSteps = gaugeScenario("steps", everyFill);
export const gaugeTile = gaugeScenario("tile", everyFill);
export const gaugeBare = gaugeScenario("bare", [3]);
export const gaugeBar = gaugeScenario("bar", [3]);
