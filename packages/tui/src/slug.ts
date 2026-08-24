import { fg, type TextChunk } from "@opentui/core";
import type { Theme } from "./theme.ts";

export type SlugRole = "word" | "separator" | "colon";

export interface SlugPart {
  readonly text: string;
  readonly role: SlugRole;
}

export function slugParts(slug: string): SlugPart[] {
  const parts: SlugPart[] = [];
  for (const piece of slug.split(/([:-])/)) {
    if (piece === "") continue;
    parts.push({ text: piece, role: roleOf(piece) });
  }
  return parts;
}

export function slugWords(slug: string): string {
  return slugParts(slug)
    .filter((part) => part.role === "word")
    .map((part) => part.text)
    .join(" ");
}

export interface SlugInk {
  readonly word: string;
  readonly separator: string;
  readonly colon: string;
}

export function slugInk(theme: Theme, word: string = theme.text): SlugInk {
  return { word, separator: theme.textDim, colon: theme.accentSoft };
}

export function slugChunks(slug: string, ink: SlugInk): TextChunk[] {
  return slugParts(slug).map((part) => fg(ink[part.role])(part.text));
}

function roleOf(piece: string): SlugRole {
  if (piece === ":") return "colon";
  if (piece === "-") return "separator";
  return "word";
}
