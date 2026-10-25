import { askArmingMs } from "../../packages/tui/src/mutation-ask.ts";
import type { Stage } from "./scenario.ts";

export const askControls = "[y] allow  [n] deny";
export const composerCursor = "› ▌";
export const composerHeld = /› +[│|]?\s*$/m;

const askRow = /[│|] \? /;

export interface SteppingClock {
  now(): number;
  advance(ms: number): void;
}

export function steppingClock(iso: string): SteppingClock {
  let at = Date.parse(iso);
  return {
    now: () => at,
    advance: (ms) => {
      at += ms;
    },
  };
}

export async function armedAsk(stage: Stage, clock?: SteppingClock): Promise<string> {
  if (clock === undefined) return stage.until(askControls);
  await stage.until(askRow);
  clock.advance(askArmingMs);
  await stage.renderOnce();
  return stage.until(askControls);
}

export async function rearmedAsk(stage: Stage): Promise<string> {
  await stage.until(composerCursor);
  return stage.until(composerHeld);
}
