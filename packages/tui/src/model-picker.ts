import { fuzzyScore } from "./commands.ts";
import type { ModelChoice } from "./inference-port.ts";
import type { Chord } from "./keys.ts";
import { type PickerKeyOutcome, pickerIntentOf } from "./picker-keys.ts";

export type { PickerKeyOutcome } from "./picker-keys.ts";

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
    const intent = pickerIntentOf(chord, sequence);
    switch (intent.kind) {
      case "close":
        return "close";
      case "choose":
        return "choose";
      case "move":
        this.move(intent.step);
        return "stay";
      case "erase":
        this.query = this.query.slice(0, -1);
        this.index = 0;
        return "stay";
      case "type":
        this.query += intent.text;
        this.index = 0;
        return "stay";
      case "ignore":
        return "stay";
    }
  }

  private move(step: number): void {
    const count = Math.max(1, this.visible().length);
    this.index = (this.index + step + count) % count;
  }
}

export function describeChoice(choice: ModelChoice): string {
  return [choice.reference, ...choice.facts].join(" · ");
}
