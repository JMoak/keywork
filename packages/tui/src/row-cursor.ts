import { clampIndex, clampScroll } from "./clamp.ts";
import type { Chord } from "./keys.ts";

export interface VisibleRow<Row> {
  readonly index: number;
  readonly row: Row;
  readonly selected: boolean;
}

export abstract class RowCursor<Row> {
  cursor = 0;
  scrollTop = 0;

  protected readonly volatileRows: boolean = false;

  private anchorKey: string | undefined;
  private revision = 0;
  private memo: { revision: number; rows: Row[] } | undefined;

  protected constructor(protected readonly notify: () => void) {}

  protected abstract buildRows(): Row[];

  protected abstract keyOf(row: Row): string;

  protected selectable(_row: Row): boolean {
    return true;
  }

  rows(): Row[] {
    if (!this.volatileRows && this.memo?.revision === this.revision) return this.memo.rows;
    const rows = this.buildRows();
    this.memo = { revision: this.revision, rows };
    return rows;
  }

  cursorRow(): Row | undefined {
    const rows = this.rows();
    return rows[clampIndex(this.cursor, rows.length)];
  }

  visibleRows(rowCount: number): VisibleRow<Row>[] {
    const all = this.rows();
    this.cursor = clampIndex(this.cursor, all.length);
    this.scrollTop = clampScroll(this.scrollTop, all.length, rowCount);
    if (this.cursor < this.scrollTop) this.scrollTop = this.cursor;
    if (this.cursor >= this.scrollTop + rowCount) this.scrollTop = this.cursor - rowCount + 1;
    return all.slice(this.scrollTop, this.scrollTop + rowCount).map((row, offset) => {
      const index = this.scrollTop + offset;
      return { index, row, selected: index === this.cursor && this.selectable(row) };
    });
  }

  selectVisible(offset: number, rowCount: number): boolean {
    const target = this.visibleRows(rowCount)[offset];
    if (target === undefined) return false;
    this.moveTo(target.index);
    return true;
  }

  protected navigate(chord: Chord, pageRows: number): boolean {
    switch (chord.name) {
      case "j":
      case "down":
        return this.moveCursor(1);
      case "k":
      case "up":
        return this.moveCursor(-1);
      case "pagedown":
        return this.moveCursor(pageRows);
      case "pageup":
        return this.moveCursor(-pageRows);
      case "home":
        return this.moveCursor(-this.rows().length);
      case "end":
        return this.moveCursor(this.rows().length);
      default:
        return false;
    }
  }

  protected moveCursor(delta: number): true {
    const stops = this.selectableIndexes();
    if (stops.length === 0) return true;
    const at = stops.findIndex((index) => index >= this.cursor);
    const current = at === -1 ? stops.length - 1 : at;
    this.moveTo(stops[clampIndex(current + delta, stops.length)] ?? this.cursor);
    return true;
  }

  protected moveTo(index: number): void {
    this.cursor = index;
    this.anchorKey = this.keyAt(index);
    this.notify();
  }

  protected mutate(action: () => void, anchor = this.currentKey()): true {
    this.rebuild(action, anchor);
    this.notify();
    return true;
  }

  protected rebuild(action: () => void, anchor = this.currentKey()): void {
    action();
    this.invalidate();
    this.reanchor(anchor);
  }

  protected invalidate(): void {
    this.revision += 1;
    this.memo = undefined;
  }

  protected currentKey(): string | undefined {
    return this.keyAt(this.cursor) ?? this.anchorKey;
  }

  private reanchor(anchor: string | undefined): void {
    const rows = this.rows();
    if (rows.length === 0) return;
    const found = rows.findIndex((row) => this.keyOf(row) === anchor);
    this.cursor = found >= 0 ? found : clampIndex(this.cursor, rows.length);
    const landed = rows[this.cursor];
    if (landed !== undefined && !this.selectable(landed)) {
      this.cursor = this.selectableIndexes()[0] ?? 0;
    }
    this.anchorKey = this.keyAt(this.cursor) ?? this.anchorKey;
  }

  private selectableIndexes(): number[] {
    return this.rows().flatMap((row, index) => (this.selectable(row) ? [index] : []));
  }

  private keyAt(index: number): string | undefined {
    const row = this.rows()[index];
    return row === undefined ? undefined : this.keyOf(row);
  }
}
