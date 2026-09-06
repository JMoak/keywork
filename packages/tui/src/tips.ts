export interface TipSignals {
  readonly paneCount: number;
  readonly costsShown: boolean;
  readonly memoryUntouched: boolean;
  readonly arcsUntouched: boolean;
}

export interface Tip {
  readonly text: string;
  wanted(signals: TipSignals): boolean;
}

export const curatedTips: readonly Tip[] = [
  { text: "ctrl+k s splits a second session in", wanted: (signals) => signals.paneCount <= 1 },
  {
    text: "/memory opens the workspace's memory garden",
    wanted: (signals) => signals.memoryUntouched,
  },
  {
    text: "/arc-new gathers related sessions into an arc",
    wanted: (signals) => signals.arcsUntouched,
  },
  { text: "/show-costs puts spend in the pane headers", wanted: (signals) => !signals.costsShown },
];

export const tipRotationMs = 10 * 60 * 1000;

export function rotatingTip(
  signals: TipSignals,
  nowMs: number,
  tips: readonly Tip[] = curatedTips,
): string | undefined {
  const eligible = tips.filter((tip) => tip.wanted(signals));
  if (eligible.length === 0) return undefined;
  return eligible[Math.floor(nowMs / tipRotationMs) % eligible.length]?.text;
}
