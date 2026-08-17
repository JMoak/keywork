export function apcaLc(inkHex: string, groundHex: string): number {
  const ink = softenNearBlack(screenLuminance(inkHex));
  const ground = softenNearBlack(screenLuminance(groundHex));
  const polarity =
    ground > ink
      ? ground ** darkInkGroundExponent - ink ** darkInkExponent
      : ground ** lightInkGroundExponent - ink ** lightInkExponent;
  const magnitude = Math.abs(polarity) * contrastScale;
  return magnitude < lowContrastClip ? 0 : (magnitude - lowContrastOffset) * 100;
}

const darkInkGroundExponent = 0.56;
const darkInkExponent = 0.57;
const lightInkGroundExponent = 0.65;
const lightInkExponent = 0.62;
const contrastScale = 1.14;
const lowContrastClip = 0.1;
const lowContrastOffset = 0.027;
const nearBlackThreshold = 0.022;
const nearBlackExponent = Math.SQRT2;
const rrggbb = /^#[0-9a-fA-F]{6}$/;

function screenLuminance(hex: string): number {
  const [r, g, b] = channels(hex);
  return 0.2126729 * gamma(r) + 0.7151522 * gamma(g) + 0.072175 * gamma(b);
}

function gamma(channel: number): number {
  return (channel / 255) ** 2.4;
}

function softenNearBlack(luminance: number): number {
  if (luminance >= nearBlackThreshold) return luminance;
  return luminance + (nearBlackThreshold - luminance) ** nearBlackExponent;
}

function channels(hex: string): [number, number, number] {
  if (!rrggbb.test(hex)) throw new Error(`Expected a #rrggbb color, got "${hex}"`);
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}
