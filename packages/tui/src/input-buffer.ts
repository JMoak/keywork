import { clamp } from "./clamp.ts";

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
    this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor);
    this.cursor -= 1;
  }

  left(): void {
    this.cursor = Math.max(0, this.cursor - 1);
  }

  right(): void {
    this.cursor = Math.min(this.text.length, this.cursor + 1);
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
    this.cursor = targetStart + clamp(column, 0, targetLine.length);
    return true;
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
