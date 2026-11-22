import { z } from "zod";

export interface Vocabulary<Word extends string> {
  readonly words: readonly Word[];
  understood(said: string): Word | undefined;
  nearestTo(said: string): readonly Word[];
}

export interface WaysOfSaying<Word extends string> {
  aliases?: Readonly<Record<string, Word>>;
  synonyms?: Readonly<Record<string, string>>;
  filler?: readonly string[];
}

export function vocabularyOf<Word extends string>(
  words: readonly Word[],
  ways: WaysOfSaying<Word> = {},
): Vocabulary<Word> {
  const tokens = tokeniserOf(ways);
  const saidAs: Array<[string, Word]> = [
    ...Object.entries(ways.aliases ?? {}),
    ...words.map((word): [string, Word] => [word, word]),
  ];
  const byKey = new Map(saidAs.map(([phrase, word]) => [keyOf(tokens(phrase)), word]));
  byKey.delete(saidNothing);
  return {
    words,
    understood: (said) => byKey.get(keyOf(tokens(said))),
    nearestTo: (said) => nearestWords(tokens(said), words, tokens),
  };
}

export function wordInput(vocabulary: Vocabulary<string>): z.ZodString {
  return z
    .string()
    .trim()
    .min(1)
    .max(longestSaid)
    .meta({ enum: [...vocabulary.words] });
}

export function misunderstoodWords(
  kind: string,
  said: string,
  vocabulary: Vocabulary<string>,
): string {
  const { words } = vocabulary;
  return words.length <= fewEnoughToList
    ? `${kind} is ${listed(words, "or")}, not ${quoted(said)}`
    : `no ${kind} is called ${quoted(said)}; the nearest are ${listed(vocabulary.nearestTo(said), "and")}`;
}

export function quoted(said: string): string {
  return JSON.stringify(said.slice(0, longestSaid));
}

export function listed(items: readonly string[], joiner: "and" | "or"): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${joiner} ${items.at(-1)}`;
}

type Tokeniser = (said: string) => string[];

const saidNothing = "";

const longestSaid = 80;

const fewEnoughToList = 7;

const nearestShown = 3;

function tokeniserOf({ synonyms = {}, filler = [] }: WaysOfSaying<string>): Tokeniser {
  const saidAs = new Map(Object.entries(synonyms));
  const dropped = new Set(filler);
  return (said) =>
    said
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .replace(/[&+]/g, " and ")
      .split(/[^a-z\d/]+/)
      .flatMap((token) => (saidAs.get(token) ?? token).split(" "))
      .filter((token) => token !== "" && !dropped.has(token));
}

function keyOf(tokens: readonly string[]): string {
  return [...tokens].sort().join(" ");
}

function nearestWords<Word extends string>(
  said: readonly string[],
  words: readonly Word[],
  tokens: Tokeniser,
): Word[] {
  const distanceTo = new Map(words.map((word) => [word, distanceBetween(said, tokens(word))]));
  return [...words]
    .sort((one, other) => (distanceTo.get(one) ?? 0) - (distanceTo.get(other) ?? 0))
    .slice(0, nearestShown);
}

function distanceBetween(said: readonly string[], word: readonly string[]): number {
  const shared = said.filter((token) => word.includes(token)).length;
  return editDistance(said.join(" "), word.join(" ")) - shared * sharedTokenWeight;
}

const sharedTokenWeight = 100;

function editDistance(one: string, other: string): number {
  let row = Array.from({ length: other.length + 1 }, (_, at) => at);
  for (let i = 1; i <= one.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= other.length; j += 1) {
      const swap = (row[j - 1] ?? 0) + (one[i - 1] === other[j - 1] ? 0 : 1);
      next.push(Math.min(swap, (row[j] ?? 0) + 1, (next[j - 1] ?? 0) + 1));
    }
    row = next;
  }
  return row[other.length] ?? 0;
}
