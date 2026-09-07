import { type GlyphSupport, resolveMark, type TieredMark, tile } from "./capability.ts";
import type { LifecycleState } from "./pane.ts";

export interface TerminalFacts {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly tty?: boolean;
}

export interface TerminalSupport {
  readonly title: boolean;
  readonly progress: boolean;
  readonly clipboard: boolean;
}

export type ProgressState = "clear" | "indeterminate" | "paused" | "error";

export interface WindowTitleState {
  readonly name?: string | undefined;
  readonly state: LifecycleState;
}

export function terminalSupport(facts: TerminalFacts = {}): TerminalSupport {
  const env = facts.env ?? process.env;
  const tty = facts.tty ?? process.stdout.isTTY === true;
  if (!tty || env.TERM === "dumb") return { title: false, progress: false, clipboard: false };
  return { title: true, progress: reportsProgress(env), clipboard: true };
}

export const pushTitle = "\x1b[22;0t";
export const popTitle = "\x1b[23;0t";

export function setTitle(text: string): string {
  return `\x1b]0;${withoutControls(text)}\x07`;
}

export function setProgress(state: ProgressState, percent = 0): string {
  return `\x1b]9;4;${progressCodes[state]};${clampPercent(percent)}\x07`;
}

export function copyToClipboard(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}

export function windowTitle(title: WindowTitleState, glyphs: GlyphSupport): string {
  const name = title.name === undefined ? appName : `${title.name} · ${appName}`;
  const mark = stateMarks[title.state];
  return mark === undefined ? name : `${resolveMark(mark, glyphs)} ${name}`;
}

export function progressOf(state: LifecycleState): ProgressState {
  return progressByState[state];
}

export class TerminalReporter {
  private lastTitle: string | undefined;
  private lastProgress: ProgressState = "clear";

  constructor(
    private readonly write: (bytes: string) => void,
    private readonly support: TerminalSupport,
    private readonly glyphs: GlyphSupport,
  ) {}

  begin(): void {
    if (this.support.title) this.write(pushTitle);
  }

  report(title: WindowTitleState): void {
    this.reportTitle(windowTitle(title, this.glyphs));
    this.reportProgress(progressOf(title.state));
  }

  end(): void {
    this.reportProgress("clear");
    if (this.support.title) this.write(popTitle);
  }

  private reportTitle(text: string): void {
    if (!this.support.title || text === this.lastTitle) return;
    this.lastTitle = text;
    this.write(setTitle(text));
  }

  private reportProgress(state: ProgressState): void {
    if (!this.support.progress || state === this.lastProgress) return;
    this.lastProgress = state;
    this.write(setProgress(state));
  }
}

const appName = "keywork";

const stateMarks: Readonly<Partial<Record<LifecycleState, TieredMark>>> = {
  working: { tier1: "▒", tier0: ":" },
  "needs-you": { tier1: "█", tier0: "#" },
  "finished-unseen": { tier1: "▓", tier0: "+" },
  failed: tile.failed,
};

const progressCodes: Readonly<Record<ProgressState, number>> = {
  clear: 0,
  indeterminate: 3,
  paused: 4,
  error: 2,
};

const progressByState: Readonly<Record<LifecycleState, ProgressState>> = {
  idle: "clear",
  "finished-unseen": "clear",
  working: "indeterminate",
  "needs-you": "paused",
  failed: "error",
};

function reportsProgress(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.WT_SESSION !== undefined || env.ConEmuANSI === "ON" || env.ConEmuPID !== undefined;
}

function clampPercent(percent: number): number {
  return Math.min(100, Math.max(0, Math.round(percent)));
}

function withoutControls(text: string): string {
  let kept = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 32 && code !== 127) kept += character;
  }
  return kept;
}
