import { keyworkNight } from "./theme.ts";

export interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

export function rampColor(ramp: readonly string[], t: number): string {
  if (ramp.length === 0) throw new Error("rampColor needs at least one stop");
  const position = clamp(t, 0, 1) * (ramp.length - 1);
  const segment = Math.min(Math.floor(position), Math.max(ramp.length - 2, 0));
  const blend = position - segment;
  const from = stopAt(ramp, segment);
  if (blend === 0) return normalizeHex(from);
  const to = stopAt(ramp, segment + 1);
  if (blend === 1) return normalizeHex(to);
  return oklchToHex(mixOklch(hexToOklch(from), hexToOklch(to), blend));
}

export function spawnRankPositions(paneCount: number): number[] {
  if (paneCount <= 0) return [];
  if (paneCount === 1) return [0];
  return Array.from({ length: paneCount }, (_, rank) => rank / (paneCount - 1));
}

export function focusLift(hex: string): string {
  const { l, c, h } = hexToOklch(hex);
  return oklchToHex({
    l: Math.max(l, focusTarget.l),
    c: c < neutralChroma ? c : Math.max(c, focusTarget.c),
    h,
  });
}

export function arcAnchor(ramp: readonly string[], k: number): string {
  const turns = k * goldenRatioConjugate;
  return rampColor(ramp, turns - Math.floor(turns));
}

export function hexToOklch(hex: string): Oklch {
  const [r, g, b] = hexChannels(hex);
  return oklabToOklch(
    linearRgbToOklab([srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255)]),
  );
}

export function oklchToHex(color: Oklch): string {
  const [r, g, b] = displayableLinearRgb(color);
  return `#${channelByte(r)}${channelByte(g)}${channelByte(b)}`;
}

const goldenRatioConjugate = 0.618033988749895;
const neutralChroma = 1e-4;
const gamutSlack = 1e-6;
const rrggbb = /^#[0-9a-fA-F]{6}$/;
const focusTarget = hexToOklch(keyworkNight.borderFocus);

type Triple = readonly [number, number, number];

function mixOklch(from: Oklch, to: Oklch, blend: number): Oklch {
  const [fromHue, toHue] = shortestHueArc(from, to);
  return {
    l: lerp(from.l, to.l, blend),
    c: lerp(from.c, to.c, blend),
    h: normalizedHue(lerp(fromHue, toHue, blend)),
  };
}

function shortestHueArc(from: Oklch, to: Oklch): [number, number] {
  if (from.c < neutralChroma) return [to.h, to.h];
  if (to.c < neutralChroma) return [from.h, from.h];
  if (to.h - from.h > 180) return [from.h + 360, to.h];
  if (from.h - to.h > 180) return [from.h, to.h + 360];
  return [from.h, to.h];
}

function displayableLinearRgb(color: Oklch): Triple {
  const direct = oklabToLinearRgb(oklchToOklab(color));
  if (isDisplayable(direct)) return direct;
  let displayableChroma = 0;
  let clippedChroma = color.c;
  for (let step = 0; step < 24; step++) {
    const midChroma = (displayableChroma + clippedChroma) / 2;
    if (isDisplayable(oklabToLinearRgb(oklchToOklab({ ...color, c: midChroma })))) {
      displayableChroma = midChroma;
    } else {
      clippedChroma = midChroma;
    }
  }
  return oklabToLinearRgb(oklchToOklab({ ...color, c: displayableChroma }));
}

function isDisplayable([r, g, b]: Triple): boolean {
  return [r, g, b].every((channel) => channel >= -gamutSlack && channel <= 1 + gamutSlack);
}

function linearRgbToOklab([r, g, b]: Triple): Triple {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToLinearRgb([l, a, b]: Triple): Triple {
  const long = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const medium = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const short = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
    -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
  ];
}

function oklabToOklch([l, a, b]: Triple): Oklch {
  const c = Math.hypot(a, b);
  return { l, c, h: c < neutralChroma ? 0 : normalizedHue((Math.atan2(b, a) * 180) / Math.PI) };
}

function oklchToOklab({ l, c, h }: Oklch): Triple {
  const radians = (h * Math.PI) / 180;
  return [l, c * Math.cos(radians), c * Math.sin(radians)];
}

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function srgbFromLinear(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
}

function channelByte(linear: number): string {
  return Math.round(srgbFromLinear(clamp(linear, 0, 1)) * 255)
    .toString(16)
    .padStart(2, "0");
}

function hexChannels(hex: string): Triple {
  const value = Number.parseInt(normalizeHex(hex).slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function normalizeHex(hex: string): string {
  if (!rrggbb.test(hex)) throw new Error(`Expected a #rrggbb color, got "${hex}"`);
  return hex.toLowerCase();
}

function stopAt(ramp: readonly string[], index: number): string {
  const stop = ramp[index];
  if (stop === undefined) throw new Error(`Ramp has no stop at ${index}`);
  return stop;
}

function normalizedHue(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

function lerp(from: number, to: number, blend: number): number {
  return from + (to - from) * blend;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
