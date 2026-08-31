import type { Scenario } from "../scenario.ts";
import { arcFold } from "./arc-fold.ts";
import { arcsOnScreen } from "./arcs.ts";
import { chromaSweep } from "./chroma-sweep.ts";
import {
  chromeStatesAscii,
  chromeStatesTiered,
  focusCornersFrame,
  focusCornersFrameAscii,
  focusCornersGrid,
  focusCornersGridAscii,
  focusRepaint,
} from "./chrome-states.ts";
import { coldStart } from "./cold-start.ts";
import { defectRepros } from "./defect-repros.ts";
import { discovery } from "./discovery.ts";
import { firstConversation } from "./first-conversation.ts";
import { livePlayground } from "./live-playground.ts";
import { longSession } from "./long-session.ts";
import { memoryAirlockStamp, memoryBrowser } from "./memory-browser.ts";
import { pageTiers } from "./page-tiers.ts";
import { pointerTour } from "./pointer-tour.ts";
import { sessionLifecycle } from "./session-lifecycle.ts";
import { tilingTour } from "./tiling-tour.ts";

export const scenarios: readonly Scenario[] = [
  coldStart,
  firstConversation,
  tilingTour,
  chromaSweep,
  chromeStatesTiered,
  chromeStatesAscii,
  focusCornersFrame,
  focusCornersGrid,
  focusCornersFrameAscii,
  focusCornersGridAscii,
  focusRepaint,
  pageTiers,
  sessionLifecycle,
  longSession,
  arcsOnScreen,
  arcFold,
  memoryBrowser,
  memoryAirlockStamp,
  discovery,
  defectRepros,
  pointerTour,
  livePlayground,
];

export function scenarioNamed(name: string): Scenario | undefined {
  return scenarios.find((scenario) => scenario.name === name);
}

export function defaultScenarios(): readonly Scenario[] {
  return scenarios.filter((scenario) => scenario.manual !== true);
}
