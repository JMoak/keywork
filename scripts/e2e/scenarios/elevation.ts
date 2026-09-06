import { textTurn } from "../../../packages/engine/src/index.ts";
import type { Scenario } from "../scenario.ts";

const firstReply = [
  "The dock keeps 0.3 of the width; panes inside it stack by weight.",
  "",
  "- the main area takes the rest",
  "- split ratios rebalance with ctrl+k r",
  "",
  "That covers the resting layout.",
].join("\n");

const secondReply = "Zooming holds the ratios; the tile returns exactly where it left.";

type Candidate = "arc-stamps" | "turn-age" | "scroll-map" | "chrome";

function elevationScenario(candidate: Candidate): Scenario {
  return {
    name: `elevation-${candidate}`,
    description: `C61 elevation candidate "${candidate}" over the same two-turn transcript`,
    size: { width: 90, height: 26 },
    files: {
      ".keywork/workspace.json": `${JSON.stringify({ name: "elevation-e2e" })}\n`,
      ".keywork/memory/MEMORY.md": "",
    },
    turns: [textTurn(firstReply), textTurn(secondReply)],
    app: { elevation: candidate },
    goldens: ["transcript"],
    run: async (stage) => {
      await stage.settle();
      await stage.type("/arc-new demo");
      await stage.press("enter");
      await stage.until("arc → demo");
      await stage.type("how does the dock behave");
      await stage.press("enter");
      await stage.until("resting layout");
      await stage.type("and zooming");
      await stage.press("enter");
      await stage.until("Zooming holds");
      await stage.settle();
      await stage.capture("transcript");
      await stage.quit();
    },
  };
}

export const elevationArcStamps = elevationScenario("arc-stamps");
export const elevationChrome = elevationScenario("chrome");
export const elevationTurnAge = elevationScenario("turn-age");
export const elevationScrollMap = elevationScenario("scroll-map");
