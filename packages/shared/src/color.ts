import { z } from "zod";

const rrggbb = /^#[0-9a-fA-F]{6}$/;

export const hexColor = z.string().regex(rrggbb, "colors must be #rrggbb");

export function canonicalHex(hex: string): string {
  if (!rrggbb.test(hex)) throw new Error(`Expected a #rrggbb color, got "${hex}"`);
  return hex.toLowerCase();
}

export function hexChannels(hex: string): [number, number, number] {
  const value = Number.parseInt(canonicalHex(hex).slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}
