import { fuzzyScore } from "./commands.ts";
import type { ModelChoice } from "./inference-port.ts";
import type { Chord } from "./keys.ts";

export type PickerKeyOutcome = "stay" | "close" | "choose";

export interface PickerRow {
  choice: ModelChoice;
  selected: boolean;
  current: boolean;
}

export class ModelPicker {
  query = "";
  private index = 0;

  constructor(
    private readonly choices: readonly ModelChoice[],
    readonly current: string | undefined,
  ) {
    const at = choices.findIndex((choice) => choice.reference === current);
    this.index = Math.max(0, at);
  }

  visible(): readonly ModelChoice[] {
    if (this.query === "") return this.choices;
    return this.choices
      .map((choice) => ({ choice, score: fuzzyScore(this.query, choice.reference) }))
      .filter((entry): entry is { choice: ModelChoice; score: number } => entry.score !== undefined)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.choice);
  }

  selected(): ModelChoice | undefined {
    return this.visible()[this.index];
  }

  rows(): PickerRow[] {
    return this.visible().map((choice, index) => ({
      choice,
      selected: index === this.index,
      current: choice.reference === this.current,
    }));
  }

  handleKey(chord: Chord, sequence: string | undefined): PickerKeyOutcome {
    if (chord.name === "escape") return "close";
    if (chord.name === "return" || chord.name === "enter") return "choose";
    if (chord.name === "up" || chord.name === "down") {
      this.move(chord.name === "down" ? 1 : -1);
      return "stay";
    }
    if (chord.name === "backspace") {
      this.query = this.query.slice(0, -1);
      this.index = 0;
      return "stay";
    }
    if (
      sequence !== undefined &&
      sequence.length === 1 &&
      !chord.ctrl &&
      !chord.meta &&
      sequence >= " "
    ) {
      this.query += sequence;
      this.index = 0;
    }
    return "stay";
  }

  private move(step: number): void {
    const count = Math.max(1, this.visible().length);
    this.index = (this.index + step + count) % count;
  }
}

export function describeChoice(choice: ModelChoice): string {
  return [choice.reference, ...choice.facts].join(" · ");
}
