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
  if (isTypedCharacter(chord, sequence)) return { kind: "type", text: sequence };
  return { kind: "ignore" };
}

function isTypedCharacter(chord: Chord, sequence: string | undefined): sequence is string {
  return (
    sequence !== undefined && sequence.length === 1 && !chord.ctrl && !chord.meta && sequence >= " "
  );
}
