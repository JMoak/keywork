import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { Chord } from "./keys.ts";

export type FileState =
  | { kind: "loading" }
  | { kind: "loaded"; lines: string[] }
  | { kind: "failed"; reason: string };

export class FileModel {
  state: FileState = { kind: "loading" };
  scrollTop = 0;
  readonly name: string;
  readonly lastLoad: Promise<void>;

  constructor(
    cwd: string,
    readonly path: string,
    private readonly notify: () => void,
  ) {
    this.name = basename(path);
    this.lastLoad = this.load(resolve(cwd, path));
  }

  handleKey(chord: Chord, pageRows: number): boolean {
    const jumps: Record<string, number> = {
      up: -1,
      down: 1,
      pageup: -pageRows,
      pagedown: pageRows,
    };
    const jump = jumps[chord.name];
    if (jump === undefined) return false;
    this.scrollBy(jump);
    return true;
  }

  visibleLines(rows: number): { number: number; text: string }[] {
    if (this.state.kind !== "loaded") return [];
    this.scrollTop = clampScroll(this.scrollTop, this.state.lines.length, rows);
    return this.state.lines
      .slice(this.scrollTop, this.scrollTop + rows)
      .map((text, index) => ({ number: this.scrollTop + index + 1, text }));
  }

  lineCount(): number {
    return this.state.kind === "loaded" ? this.state.lines.length : 0;
  }

  private scrollBy(delta: number): void {
    this.scrollTop = Math.max(0, this.scrollTop + delta);
    this.notify();
  }

  private async load(absolutePath: string): Promise<void> {
    try {
      const content = await readFile(absolutePath, "utf8");
      this.state = content.includes("\u0000")
        ? { kind: "failed", reason: "binary file" }
        : { kind: "loaded", lines: content.split(/\r?\n/) };
    } catch (cause) {
      this.state = { kind: "failed", reason: (cause as Error).message };
    }
    this.notify();
  }
}

function clampScroll(scrollTop: number, lineCount: number, rows: number): number {
  return Math.max(0, Math.min(scrollTop, Math.max(0, lineCount - rows)));
}
