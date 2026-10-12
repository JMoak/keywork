import { hexChannels } from "./color.ts";

export function mixOklab(fromHex: string, towardHex: string, amount: number): string {
  const blend = Math.min(Math.max(amount, 0), 1);
  const from = hexToOklab(fromHex);
  const toward = hexToOklab(towardHex);
  return oklabToHex([
    from[0] + (toward[0] - from[0]) * blend,
    from[1] + (toward[1] - from[1]) * blend,
    from[2] + (toward[2] - from[2]) * blend,
  ]);
}

type Triple = readonly [number, number, number];

function hexToOklab(hex: string): Triple {
  const [red, green, blue] = hexChannels(hex);
  const r = srgbToLinear(red / 255);
  const g = srgbToLinear(green / 255);
  const b = srgbToLinear(blue / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToHex([l, a, b]: Triple): string {
  const long = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const medium = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const short = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
    -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
  ];
  return `#${linear.map(channelByte).join("")}`;
}

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function channelByte(linear: number): string {
  const clamped = Math.min(Math.max(linear, 0), 1);
  const encoded = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255)
    .toString(16)
    .padStart(2, "0");
}
