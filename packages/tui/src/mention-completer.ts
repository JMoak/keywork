import { fuzzyScore } from "./commands.ts";

export interface MentionToken {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

export interface MentionedPath {
  readonly relative: string;
}

export type MentionSource = () => readonly MentionedPath[];

export function mentionAt(text: string, cursor: number): MentionToken | undefined {
  let queryStart = cursor;
  while (queryStart > 0 && isPathCharacter(text[queryStart - 1] ?? "")) queryStart -= 1;
  const at = queryStart - 1;
  if (text[at] !== "@" || !opensMention(text, at)) return undefined;
  let end = cursor;
  while (end < text.length && isPathCharacter(text[end] ?? "")) end += 1;
  return { start: at, end, query: text.slice(queryStart, cursor) };
}

export function rankMentions(
  query: string,
  paths: readonly MentionedPath[],
  limit: number,
): string[] {
  const needle = query.toLowerCase();
  return paths
    .map(({ relative }) => relative)
    .filter((path) => mentionable(path) && (revealsHidden(needle) || !isHidden(path)))
    .map((path) => ({ path, score: mentionScore(needle, path) }))
    .filter((match): match is { path: string; score: number } => match.score !== undefined)
    .sort((left, right) => right.score - left.score || left.path.length - right.path.length)
    .slice(0, limit)
    .map(({ path }) => path);
}

export function insertedMention(path: string): string {
  return `@${path} `;
}

function mentionScore(needle: string, path: string): number | undefined {
  const lowered = path.toLowerCase();
  if (needle === "") return -depthOf(path) - path.length / 1000;
  const whole = fuzzyScore(needle, lowered);
  if (needle.includes("/")) return whole;
  const name = fuzzyScore(needle, baseName(lowered));
  if (name === undefined) return whole;
  return Math.max(name + baseNameBonus, whole ?? Number.NEGATIVE_INFINITY);
}

function opensMention(text: string, at: number): boolean {
  if (at === 0) return true;
  return mentionOpeners.test(text[at - 1] ?? "");
}

function isPathCharacter(character: string): boolean {
  return pathCharacter.test(character);
}

function mentionable(path: string): boolean {
  return wholePath.test(path);
}

function isHidden(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."));
}

function revealsHidden(needle: string): boolean {
  return needle.startsWith(".") || needle.includes("/.");
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function depthOf(path: string): number {
  return path.split("/").length;
}

const baseNameBonus = 100;
const pathCharacter = /^[\w./\\~-]$/;
const wholePath = /^[\w./~-]+$/;
const mentionOpeners = /[\s("'[{<=:,]/;
