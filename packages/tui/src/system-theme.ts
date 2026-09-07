import { type Flavor, parseFlavor } from "@keywork/shared";
import { blendToward, hexToOklch, inkClearingFloor, shiftLightness } from "./chroma.ts";
import { type DebounceTiming, realTiming } from "./debounce.ts";
import { keyworkNightFlavor } from "./flavor.ts";
import {
  colorQueries,
  colorRepliesComplete,
  parseColorReplies,
  type TerminalColors,
} from "./osc.ts";
import type { Theme } from "./theme.ts";

export interface ColorTransport {
  write(bytes: string): void;
  onData(listener: (bytes: string) => void): () => void;
}

export interface TerminalColorFacts {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly tty?: boolean;
  readonly transport?: ColorTransport;
  readonly timing?: DebounceTiming;
  readonly timeoutMs?: number;
}

export type RawInput = NodeJS.ReadStream & {
  setRawMode?(raw: boolean): unknown;
  isRaw?: boolean | undefined;
};

export const systemFlavorName = "system";
export const colorQueryTimeoutMs = 200;

export async function detectTerminalColors(
  facts: TerminalColorFacts = {},
): Promise<TerminalColors | undefined> {
  const env = facts.env ?? process.env;
  const tty = facts.tty ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  const answered =
    tty && env.TERM !== "dumb" && facts.transport !== undefined
      ? await queryTerminalColors(facts.transport, facts.timing, facts.timeoutMs)
      : undefined;
  return answered ?? colorsFromEnv(env);
}

export function queryTerminalColors(
  transport: ColorTransport,
  timing: DebounceTiming = realTiming,
  timeoutMs = colorQueryTimeoutMs,
): Promise<TerminalColors | undefined> {
  return new Promise((resolve) => {
    let received = "";
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      stopListening();
      cancelTimeout();
      const colors = parseColorReplies(received);
      resolve(colors.background === undefined ? undefined : colors);
    };
    const stopListening = transport.onData((bytes) => {
      received += bytes;
      if (colorRepliesComplete(parseColorReplies(received))) finish();
    });
    const cancelTimeout = timing.after(timeoutMs, finish);
    transport.write(colorQueries());
  });
}

export function colorsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): TerminalColors | undefined {
  const parts = env.COLORFGBG?.split(";") ?? [];
  const foreground = xtermColor(parts[0]);
  const background = xtermColor(parts.at(-1));
  if (parts.length < 2 || background === undefined) return undefined;
  return { ...(foreground !== undefined && { foreground }), background, ansi: new Map() };
}

export function systemFlavor(
  colors: TerminalColors | undefined,
  fallback: Flavor = keyworkNightFlavor,
): Flavor {
  if (colors?.background === undefined) return { ...fallback, name: systemFlavorName };
  const tokens = systemTokens(colors);
  return parseFlavor({
    name: systemFlavorName,
    appearance: isDark(tokens.background) ? "dark" : "light",
    tokens,
    density: { light: "textDim", medium: "textMid", heavy: "text", full: "accent" },
    gap: 0,
    chromeWeight: "seams",
    instruments: "calm",
  });
}

export function systemTokens(colors: TerminalColors): Theme {
  const background = colors.background;
  if (background === undefined) throw new Error("systemTokens needs the terminal background");
  const dark = isDark(background);
  const lift = dark ? 1 : -1;
  const panel = shiftLightness(background, panelStep * lift);
  const panelLift = shiftLightness(background, 2 * panelStep * lift);
  const text = clearingAll(
    colors.foreground ?? (dark ? "#e6e6e6" : "#1a1a1a"),
    [background, panel, panelLift],
    floors.text,
  );
  const ink = (blend: number, floor: number): string =>
    inkClearingFloor(blendToward(text, background, blend), background, floor);
  const ansi = (index: number, floor: number): string =>
    inkClearingFloor(colors.ansi.get(index) ?? xtermPalette[index] ?? text, background, floor);
  const accent = ansi(brightBlue, floors.accent);
  return {
    background,
    panel,
    panelLift,
    text,
    textMid: ink(0.4, floors.textMid),
    textDim: ink(0.62, floors.textDim),
    border: ink(0.8, floors.border),
    borderFocus: accent,
    accent,
    accentSoft: ansi(blue, floors.accentSoft),
    success: ansi(brightGreen, floors.outcome),
    error: ansi(brightRed, floors.outcome),
    ramp: [accent, ansi(brightCyan, floors.accent)],
  };
}

export function stdioColorTransport(input: RawInput, output: NodeJS.WriteStream): ColorTransport {
  return {
    write: (bytes) => output.write(bytes),
    onData: (listener) => {
      const wasRaw = input.isRaw === true;
      input.setRawMode?.(true);
      const onData = (chunk: Buffer | string): void => listener(chunk.toString());
      input.on("data", onData);
      input.resume();
      return () => {
        input.off("data", onData);
        input.pause();
        input.setRawMode?.(wasRaw);
      };
    },
  };
}

const panelStep = 0.035;
const blue = 4;
const brightRed = 9;
const brightGreen = 10;
const brightBlue = 12;
const brightCyan = 14;

const floors = {
  text: 60,
  textMid: 30,
  textDim: 15,
  border: 5,
  accent: 40,
  accentSoft: 25,
  outcome: 40,
} as const;

const xtermPalette: readonly string[] = [
  "#000000",
  "#cd0000",
  "#00cd00",
  "#cdcd00",
  "#0000ee",
  "#cd00cd",
  "#00cdcd",
  "#e5e5e5",
  "#7f7f7f",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#5c5cff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
];

function isDark(hex: string): boolean {
  return hexToOklch(hex).l < 0.5;
}

function clearingAll(hex: string, grounds: readonly string[], floor: number): string {
  return grounds.reduce((ink, ground) => inkClearingFloor(ink, ground, floor), hex);
}

function xtermColor(index: string | undefined): string | undefined {
  if (index === undefined || !/^\d+$/.test(index)) return undefined;
  return xtermPalette[Number(index)];
}
