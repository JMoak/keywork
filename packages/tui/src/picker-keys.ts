import type { Chord } from "./keys.ts";

export type PickerKeyOutcome = "stay" | "close" | "choose";

export type PickerIntent =
  | { kind: "close" }
  | { kind: "choose" }
  | { kind: "move"; step: 1 | -1 }
  | { kind: "erase" }
  | { kind: "type"; text: string }
  | { kind: "ignore" };

export function pickerIntentOf(chord: Chord, sequence: string | undefined): PickerIntent {
  if (chord.name === "escape") return { kind: "close" };
  if (chord.name === "return" || chord.name === "enter") return { kind: "choose" };
  if (chord.name === "up" || chord.name === "down") {
    return { kind: "move", step: chord.name === "down" ? 1 : -1 };
  }
  if (chord.name === "backspace") return { kind: "erase" };
  if (isPrintable(chord, sequence)) return { kind: "type", text: sequence };
  return { kind: "ignore" };
}

export function isPrintable(chord: Chord, sequence: string | undefined): sequence is string {
  if (sequence === undefined || sequence === "" || chord.ctrl || chord.meta) return false;
  for (const character of sequence) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return false;
  }
  return true;
}
