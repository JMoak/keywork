import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { clampScroll } from "./clamp.ts";
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
    options: { atEnd?: true } = {},
  ) {
    this.name = basename(path);
    this.lastLoad = this.load(resolve(cwd, path), options.atEnd === true);
  }

  handleKey(chord: Chord, pageRows: number): boolean {
    switch (chord.name) {
      case "up":
        return this.scrollBy(-1);
      case "down":
        return this.scrollBy(1);
      case "pageup":
        return this.scrollBy(-pageRows);
      case "pagedown":
        return this.scrollBy(pageRows);
      case "home":
        return this.scrollTo(0);
      case "end":
        return this.scrollTo(this.lineCount());
      default:
        return false;
    }
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

  private scrollBy(delta: number): boolean {
    this.scrollTop = Math.max(0, this.scrollTop + delta);
    this.notify();
    return true;
  }

  private scrollTo(top: number): boolean {
    this.scrollTop = Math.max(0, top);
    this.notify();
    return true;
  }

  private async load(absolutePath: string, atEnd: boolean): Promise<void> {
    try {
      const { size } = await stat(absolutePath);
      if (size > maxFileBytes) {
        this.state = { kind: "failed", reason: `file too large (${megabytes(size)} MB)` };
        this.notify();
        return;
      }
      const content = await readFile(absolutePath, "utf8");
      this.state = content.includes("\u0000")
        ? { kind: "failed", reason: "binary file" }
        : { kind: "loaded", lines: content.split(/\r?\n/) };
      if (atEnd) this.scrollTop = this.lineCount();
    } catch (cause) {
      this.state = { kind: "failed", reason: (cause as Error).message };
    }
    this.notify();
  }
}

const maxFileBytes = 20 * 1024 * 1024;

function megabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}
