import { fuzzyScore } from "./commands.ts";
import type { Chord } from "./keys.ts";

export type PickerKeyOutcome = "stay" | "close" | "choose";

export interface PickerKeyTarget {
  readonly query: string;
  move(step: 1 | -1): void;
  retype(query: string): void;
}

export function runPickerKey(
  chord: Chord,
  sequence: string | undefined,
  target: PickerKeyTarget,
): PickerKeyOutcome {
  const intent = pickerIntentOf(chord, sequence);
  switch (intent.kind) {
    case "close":
      return "close";
    case "choose":
      return "choose";
    case "move":
      target.move(intent.step);
      return "stay";
    case "erase":
      target.retype(target.query.slice(0, -1));
      return "stay";
    case "type":
      target.retype(target.query + intent.text);
      return "stay";
    case "ignore":
      return "stay";
  }
}

export function rankByFuzzy<Item>(
  items: readonly Item[],
  needle: string,
  keyOf: (item: Item) => string,
): Item[] {
  if (needle === "") return [...items];
  return items
    .flatMap((item) => {
      const score = fuzzyScore(needle, keyOf(item));
      return score === undefined ? [] : [{ item, score }];
    })
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.item);
}

export function isPrintable(chord: Chord, sequence: string | undefined): sequence is string {
  if (sequence === undefined || sequence === "" || chord.ctrl || chord.meta) return false;
  for (const character of sequence) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return false;
  }
  return true;
}

type PickerIntent =
  | { kind: "close" }
  | { kind: "choose" }
  | { kind: "move"; step: 1 | -1 }
  | { kind: "erase" }
  | { kind: "type"; text: string }
  | { kind: "ignore" };

function pickerIntentOf(chord: Chord, sequence: string | undefined): PickerIntent {
  if (chord.name === "escape") return { kind: "close" };
  if (chord.name === "return" || chord.name === "enter") return { kind: "choose" };
  if (chord.name === "up" || chord.name === "down") {
    return { kind: "move", step: chord.name === "down" ? 1 : -1 };
  }
  if (chord.name === "tab") return { kind: "move", step: chord.shift ? -1 : 1 };
  if (chord.name === "backspace") return { kind: "erase" };
  if (isPrintable(chord, sequence)) return { kind: "type", text: sequence };
  return { kind: "ignore" };
}
