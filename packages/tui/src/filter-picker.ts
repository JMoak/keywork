import { clampIndex } from "./clamp.ts";
import type { Chord } from "./keys.ts";
import { type PickerKeyOutcome, runPickerKey } from "./picker-keys.ts";

export class FilterPicker<Row> {
  query = "";
  private index: number;

  constructor(
    private readonly rowsFor: (needle: string) => readonly Row[],
    startOn?: (row: Row) => boolean,
  ) {
    this.index = startOn === undefined ? 0 : Math.max(0, this.rows().findIndex(startOn));
  }

  rows(): readonly Row[] {
    return this.rowsFor(this.query.trim().toLowerCase());
  }

  cursor(): number {
    return clampIndex(this.index, this.rows().length);
  }

  selected(): Row | undefined {
    return this.rows()[this.cursor()];
  }

  select(at: number): void {
    this.index = clampIndex(at, this.rows().length);
  }

  move(step: 1 | -1): void {
    const count = Math.max(1, this.rows().length);
    this.index = (this.cursor() + step + count) % count;
  }

  retype(query: string): void {
    this.query = query;
    this.index = 0;
  }

  paste(text: string): void {
    this.retype(this.query + text);
  }

  handleKey(chord: Chord, sequence: string | undefined): PickerKeyOutcome {
    return runPickerKey(chord, sequence, this);
  }
}
