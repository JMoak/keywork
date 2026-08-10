import { clamp } from "./clamp.ts";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export class InputBuffer {
  private text = "";
  private cursor = 0;

  get value(): string {
    return this.text;
  }

  isEmpty(): boolean {
    return this.text === "";
  }

  load(text: string): void {
    this.text = text;
    this.cursor = text.length;
  }

  clear(): void {
    this.load("");
  }

  insert(piece: string): void {
    this.text = this.text.slice(0, this.cursor) + piece + this.text.slice(this.cursor);
    this.cursor += piece.length;
  }

  newline(): void {
    this.insert("\n");
  }

  backspace(): void {
    if (this.cursor === 0) return;
    const start = this.boundaryBefore(this.cursor);
    this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
    this.cursor = start;
  }

  left(): void {
    this.cursor = this.boundaryBefore(this.cursor);
  }

  right(): void {
    this.cursor = this.boundaryAfter(this.cursor);
  }

  home(): void {
    this.cursor = this.lineStart(this.cursor);
  }

  end(): void {
    this.cursor = this.lineEnd(this.cursor);
  }

  up(): boolean {
    return this.verticalMove(-1);
  }

  down(): boolean {
    return this.verticalMove(1);
  }

  lines(): string[] {
    return this.text.split("\n");
  }

  cursorAt(): { line: number; column: number } {
    const before = this.text.slice(0, this.cursor).split("\n");
    return { line: before.length - 1, column: before.at(-1)?.length ?? 0 };
  }

  private verticalMove(direction: -1 | 1): boolean {
    const lines = this.lines();
    const { line, column } = this.cursorAt();
    const target = line + direction;
    if (target < 0 || target >= lines.length) return false;
    const targetLine = lines[target] ?? "";
    const targetStart = lines.slice(0, target).reduce((at, text) => at + text.length + 1, 0);
    this.cursor = this.boundaryAtOrBefore(targetStart + clamp(column, 0, targetLine.length));
    return true;
  }

  private boundaryBefore(at: number): number {
    let previous = 0;
    for (const segment of graphemes.segment(this.text)) {
      if (segment.index >= at) break;
      previous = segment.index;
    }
    return previous;
  }

  private boundaryAfter(at: number): number {
    for (const segment of graphemes.segment(this.text)) {
      if (segment.index > at) return segment.index;
    }
    return this.text.length;
  }

  private boundaryAtOrBefore(at: number): number {
    if (at >= this.text.length) return this.text.length;
    let previous = 0;
    for (const segment of graphemes.segment(this.text)) {
      if (segment.index > at) break;
      previous = segment.index;
    }
    return previous;
  }

  private lineStart(from: number): number {
    if (from === 0) return 0;
    const newlineBefore = this.text.lastIndexOf("\n", from - 1);
    return newlineBefore === -1 ? 0 : newlineBefore + 1;
  }

  private lineEnd(from: number): number {
    const newlineAfter = this.text.indexOf("\n", from);
    return newlineAfter === -1 ? this.text.length : newlineAfter;
  }
}
