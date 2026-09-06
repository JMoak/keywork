import type { Scenario } from "../scenario.ts";
import { arcFold } from "./arc-fold.ts";
import { arcsOnScreen } from "./arcs.ts";
import { botsTour, botsTourAscii } from "./bots.ts";
import { chromaSweep } from "./chroma-sweep.ts";
import {
  chromeStatesAscii,
  chromeStatesDimOff,
  chromeStatesDimOn,
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
import {
  elevationArcStamps,
  elevationChrome,
  elevationScrollMap,
  elevationTurnAge,
} from "./elevation.ts";
import { firstConversation } from "./first-conversation.ts";
import { gardenHeatInk, gardenHeatLead } from "./garden-heat.ts";
import { gaugeBar, gaugeBare, gaugeRamp, gaugeSteps, gaugeTile } from "./gauge-forms.ts";
import { livePlayground } from "./live-playground.ts";
import { longSession } from "./long-session.ts";
import { lspLoop } from "./lsp-loop.ts";
import { mastheadLadder } from "./masthead-ladder.ts";
import { memoryAirlockTail, memoryBrowser } from "./memory-browser.ts";
import { pageTiers } from "./page-tiers.ts";
import { pointerOff } from "./pointer-off.ts";
import { pointerTour } from "./pointer-tour.ts";
import { sessionLifecycle } from "./session-lifecycle.ts";
import { statusTips } from "./status-tips.ts";
import { tilingTour } from "./tiling-tour.ts";
import { trayTour } from "./tray-tour.ts";

export const scenarios: readonly Scenario[] = [
  coldStart,
  firstConversation,
  tilingTour,
  lspLoop,
  chromaSweep,
  chromeStatesTiered,
  chromeStatesAscii,
  chromeStatesDimOn,
  chromeStatesDimOff,
  focusCornersFrame,
  focusCornersGrid,
  focusCornersFrameAscii,
  focusCornersGridAscii,
  focusRepaint,
  pageTiers,
  mastheadLadder,
  sessionLifecycle,
  longSession,
  gaugeRamp,
  gaugeSteps,
  gaugeTile,
  gaugeBare,
  gaugeBar,
  elevationArcStamps,
  elevationTurnAge,
  elevationScrollMap,
  elevationChrome,
  arcsOnScreen,
  arcFold,
  botsTour,
  botsTourAscii,
  memoryBrowser,
  memoryAirlockTail,
  gardenHeatLead,
  gardenHeatInk,
  statusTips,
  discovery,
  defectRepros,
  pointerTour,
  pointerOff,
  trayTour,
  livePlayground,
];

export function scenarioNamed(name: string): Scenario | undefined {
  return scenarios.find((scenario) => scenario.name === name);
}

export function defaultScenarios(): readonly Scenario[] {
  return scenarios.filter((scenario) => scenario.manual !== true);
}
