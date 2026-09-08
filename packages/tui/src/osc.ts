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

export type FocusEvent = "focus-in" | "focus-out";

export interface WindowTitleState {
  readonly name?: string | undefined;
  readonly state: LifecycleState;
}

export interface TerminalColors {
  readonly foreground?: string;
  readonly background?: string;
  readonly ansi: ReadonlyMap<number, string>;
}

export function terminalSupport(facts: TerminalFacts = {}): TerminalSupport {
  const env = facts.env ?? process.env;
  const tty = facts.tty ?? process.stdout.isTTY === true;
  if (!tty || env.TERM === "dumb") return { title: false, progress: false, clipboard: false };
  return { title: true, progress: reportsProgress(env), clipboard: true };
}

export const pushTitle = "\x1b[22;0t";
export const popTitle = "\x1b[23;0t";
export const enableFocusReporting = "\x1b[?1004h";
export const disableFocusReporting = "\x1b[?1004l";
export const bell = "\x07";

export function setTitle(text: string): string {
  return `\x1b]0;${withoutControls(text)}\x07`;
}

export function setProgress(state: ProgressState, percent = 0): string {
  return `\x1b]9;4;${progressCodes[state]};${clampPercent(percent)}\x07`;
}

export function copyToClipboard(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}

export function notifyOsc777(title: string, body: string): string {
  return `\x1b]777;notify;${withoutFieldSeparators(title)};${withoutFieldSeparators(body)}\x07`;
}

export function notifyOsc9(text: string): string {
  return `\x1b]9;${withoutControls(text)}\x07`;
}

export function focusEventsIn(bytes: string): readonly FocusEvent[] {
  const events: FocusEvent[] = [];
  for (let at = bytes.indexOf(csi); at !== -1; at = bytes.indexOf(csi, at + 1)) {
    const final = bytes[at + csi.length];
    if (final === "I") events.push("focus-in");
    else if (final === "O") events.push("focus-out");
  }
  return events;
}

export function windowTitle(title: WindowTitleState, glyphs: GlyphSupport): string {
  const name = title.name === undefined ? appName : `${title.name} · ${appName}`;
  const mark = stateMarks[title.state];
  return mark === undefined ? name : `${resolveMark(mark, glyphs)} ${name}`;
}

export function progressOf(state: LifecycleState): ProgressState {
  return progressByState[state];
}

export const queryForeground = "\x1b]10;?\x1b\\";
export const queryBackground = "\x1b]11;?\x1b\\";

export function queryAnsiColor(index: number): string {
  return `\x1b]4;${index};?\x1b\\`;
}

export function colorQueries(): string {
  return [
    queryBackground,
    queryForeground,
    ...Array.from({ length: ansiColorCount }, (_, index) => queryAnsiColor(index)),
  ].join("");
}

export function parseColorReplies(bytes: string): TerminalColors {
  const ansi = new Map<number, string>();
  let foreground: string | undefined;
  let background: string | undefined;
  for (const match of bytes.matchAll(colorReply)) {
    const color = hexOfColorSpec(match[3] ?? "");
    if (color === undefined) continue;
    if (match[1] === "10") foreground = color;
    else if (match[1] === "11") background = color;
    else ansi.set(Number(match[2]), color);
  }
  return {
    ...(foreground !== undefined && { foreground }),
    ...(background !== undefined && { background }),
    ansi,
  };
}

export function colorRepliesComplete(colors: TerminalColors): boolean {
  return (
    colors.foreground !== undefined &&
    colors.background !== undefined &&
    colors.ansi.size >= ansiColorCount
  );
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

const csi = "\x1b[";

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

function withoutFieldSeparators(text: string): string {
  return withoutControls(text).replaceAll(";", ",");
}

function withoutControls(text: string): string {
  let kept = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 32 && code !== 127) kept += character;
  }
  return kept;
}

const ansiColorCount = 16;
const escapeByte = "\x1b";
const colorReply = new RegExp(
  `${escapeByte}\\](10|11|4;(\\d+));([^${bell}${escapeByte}]*)(?:${bell}|${escapeByte}\\\\)`,
  "g",
);
const x11Rgb = /^rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\/[0-9a-f]{1,4})?$/i;
const x11Hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{9}|[0-9a-f]{12})$/i;

function hexOfColorSpec(spec: string): string | undefined {
  const rgb = spec.match(x11Rgb);
  if (rgb !== null) return hexOfChannels([rgb[1], rgb[2], rgb[3]].map((digits) => digits ?? ""));
  const hex = spec.match(x11Hex);
  if (hex === null) return undefined;
  const digits = hex[1] ?? "";
  const width = digits.length / 3;
  return hexOfChannels(
    [0, 1, 2].map((channel) => digits.slice(channel * width, (channel + 1) * width)),
  );
}

function hexOfChannels(digitGroups: readonly string[]): string {
  const bytes = digitGroups.map((digits) => {
    const scale = 16 ** digits.length - 1;
    return Math.round((Number.parseInt(digits, 16) / scale) * 255);
  });
  return `#${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
