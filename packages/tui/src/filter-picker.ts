import { clampIndex, clampScroll } from "./clamp.ts";
import type { Chord } from "./keys.ts";
import { type PickerKeyOutcome, runPickerKey } from "./picker-keys.ts";
import type { VisibleRow } from "./row-cursor.ts";

export interface FilterPage<Row> {
  rows: readonly VisibleRow<Row>[];
  above: number;
  below: number;
}

export class FilterPicker<Row> {
  query = "";
  private index: number;
  private top = 0;

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

  page(room: number): FilterPage<Row> {
    const rows = this.rows();
    const cursor = clampIndex(this.index, rows.length);
    this.top = topShowing(cursor, this.top, rows.length, room);
    const shown = rows.slice(this.top, this.top + room).map((row, offset) => {
      const index = this.top + offset;
      return { index, row, selected: index === cursor };
    });
    return { rows: shown, above: this.top, below: rows.length - this.top - shown.length };
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
    this.top = 0;
  }

  paste(text: string): void {
    this.retype(this.query + text);
  }

  handleKey(chord: Chord, sequence: string | undefined): PickerKeyOutcome {
    return runPickerKey(chord, sequence, this);
  }
}

function topShowing(cursor: number, top: number, count: number, room: number): number {
  const kept = clampScroll(top, count, room);
  if (cursor < kept) return cursor;
  if (cursor >= kept + room) return cursor - room + 1;
  return kept;
}
