import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fuzzyScore } from "./commands.ts";
import type { Chord } from "./keys.ts";

export interface Entry {
  name: string;
  kind: "file" | "dir";
}

export type ReadDirectory = (path: string) => Promise<Entry[]>;

export async function readDirectoryFromDisk(path: string): Promise<Entry[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return entries.map((entry) => ({
    name: entry.name,
    kind: entry.isDirectory() ? ("dir" as const) : ("file" as const),
  }));
}

export interface BrowserRow {
  path: string;
  name: string;
  kind: "file" | "dir";
  depth: number;
  expanded: boolean;
  hidden: boolean;
  load: "ready" | "loading" | "failed";
  failure: string | undefined;
}

export class BrowserModel {
  readonly name: string;
  cursor = 0;
  scrollTop = 0;
  showHidden = false;
  filterQuery = "";
  filtering = false;

  private readonly directories = new Map<string, DirectoryState>();
  private readonly expandedDirs = new Set<string>();
  private readonly pendingReads = new Set<Promise<void>>();
  private anchorPath: string | undefined;

  constructor(
    readonly rootPath: string,
    private readonly readDirectory: ReadDirectory,
    private readonly notify: () => void,
    private readonly openFile: (path: string) => void,
  ) {
    this.name = basename(rootPath) || rootPath;
    this.expandedDirs.add(rootPath);
    this.ensureLoaded(rootPath);
  }

  rows(): BrowserRow[] {
    const rows: BrowserRow[] = [];
    this.collect(this.rootPath, 0, rows);
    if (this.filterQuery === "") return rows;
    const query = this.filterQuery.toLowerCase();
    return rows.filter((row) => fuzzyScore(query, row.name.toLowerCase()) !== undefined);
  }

  visibleRows(rowCount: number): { index: number; row: BrowserRow }[] {
    const all = this.rows();
    this.cursor = clampIndex(this.cursor, all.length);
    this.scrollTop = clampScroll(this.scrollTop, all.length, rowCount);
    if (this.cursor < this.scrollTop) this.scrollTop = this.cursor;
    if (this.cursor >= this.scrollTop + rowCount) this.scrollTop = this.cursor - rowCount + 1;
    return all
      .slice(this.scrollTop, this.scrollTop + rowCount)
      .map((row, offset) => ({ index: this.scrollTop + offset, row }));
  }

  entryCount(): number {
    return this.rows().length;
  }

  rootFailure(): string | undefined {
    const state = this.directories.get(this.rootPath);
    return state?.kind === "failed" ? state.reason : undefined;
  }

  rootLoading(): boolean {
    return this.directories.get(this.rootPath)?.kind !== "loaded";
  }

  handleKey(chord: Chord, pageRows: number): boolean {
    if (this.filtering) return this.handleFilterKey(chord, pageRows);
    const rows = this.rows();
    this.cursor = clampIndex(this.cursor, rows.length);
    switch (chord.name) {
      case "j":
      case "down":
        return this.moveCursor(1, rows);
      case "k":
      case "up":
        return this.moveCursor(-1, rows);
      case "pagedown":
        return this.moveCursor(pageRows, rows);
      case "pageup":
        return this.moveCursor(-pageRows, rows);
      case "h":
        return this.collapseOrJumpToParent(rows);
      case "l":
      case "enter":
      case "return":
        return this.expandOrOpen(rows[this.cursor]);
      case ".":
        return this.mutate(() => {
          this.showHidden = !this.showHidden;
        });
      case "r":
        return this.mutate(() => this.dropCaches());
      case "/":
        this.filtering = true;
        this.notify();
        return true;
      case "escape":
        if (this.filterQuery === "") return false;
        return this.mutate(() => {
          this.filterQuery = "";
        });
      default:
        return false;
    }
  }

  async settled(): Promise<void> {
    while (this.pendingReads.size > 0) await Promise.all([...this.pendingReads]);
  }

  private handleFilterKey(chord: Chord, pageRows: number): boolean {
    switch (chord.name) {
      case "escape":
        this.filtering = false;
        return this.mutate(() => {
          this.filterQuery = "";
        });
      case "enter":
      case "return":
        this.filtering = false;
        this.notify();
        return true;
      case "backspace":
        return this.mutate(() => {
          this.filterQuery = this.filterQuery.slice(0, -1);
        });
      case "up":
        return this.moveCursor(-1, this.rows());
      case "down":
        return this.moveCursor(1, this.rows());
      case "pageup":
        return this.moveCursor(-pageRows, this.rows());
      case "pagedown":
        return this.moveCursor(pageRows, this.rows());
      default:
        if (!isPrintable(chord)) return false;
        return this.mutate(() => {
          this.filterQuery += chord.name;
        });
    }
  }

  private moveCursor(delta: number, rows: BrowserRow[]): boolean {
    this.cursor = clampIndex(this.cursor + delta, rows.length);
    this.anchorPath = rows[this.cursor]?.path;
    this.notify();
    return true;
  }

  private collapseOrJumpToParent(rows: BrowserRow[]): boolean {
    const row = rows[this.cursor];
    if (row === undefined) return true;
    if (row.kind === "dir" && this.expandedDirs.has(row.path)) {
      return this.mutate(() => this.expandedDirs.delete(row.path));
    }
    const parentAt = rows.findIndex((candidate) => candidate.path === dirname(row.path));
    if (parentAt >= 0) {
      this.cursor = parentAt;
      this.anchorPath = rows[parentAt]?.path;
      this.notify();
    }
    return true;
  }

  private expandOrOpen(row: BrowserRow | undefined): boolean {
    if (row === undefined) return true;
    if (row.kind === "file") {
      this.openFile(row.path);
      return true;
    }
    if (!this.expandedDirs.has(row.path)) {
      this.expandedDirs.add(row.path);
      this.ensureLoaded(row.path);
      this.notify();
    }
    return true;
  }

  private mutate(action: () => void): boolean {
    this.anchorPath = this.rows()[this.cursor]?.path ?? this.anchorPath;
    action();
    this.reanchor();
    this.notify();
    return true;
  }

  private reanchor(): void {
    const rows = this.rows();
    if (rows.length === 0) return;
    const found = rows.findIndex((row) => row.path === this.anchorPath);
    this.cursor = found >= 0 ? found : clampIndex(this.cursor, rows.length);
    this.anchorPath = rows[this.cursor]?.path ?? this.anchorPath;
  }

  private dropCaches(): void {
    this.directories.clear();
    this.ensureLoaded(this.rootPath);
  }

  private collect(directoryPath: string, depth: number, out: BrowserRow[]): void {
    const state = this.directories.get(directoryPath);
    if (state?.kind !== "loaded") return;
    for (const entry of state.entries) {
      const hidden = entry.name.startsWith(".");
      if (hidden && !this.showHidden) continue;
      const path = join(directoryPath, entry.name);
      const expanded = entry.kind === "dir" && this.expandedDirs.has(path);
      if (expanded) this.ensureLoaded(path);
      out.push({
        path,
        name: entry.name,
        kind: entry.kind,
        depth,
        expanded,
        hidden,
        ...loadOf(expanded ? this.directories.get(path) : undefined),
      });
      if (expanded) this.collect(path, depth + 1, out);
    }
  }

  private ensureLoaded(path: string): void {
    if (this.directories.has(path)) return;
    this.directories.set(path, { kind: "loading" });
    const read = this.readDirectory(path)
      .then((entries) => {
        this.directories.set(path, { kind: "loaded", entries: sortEntries(entries) });
      })
      .catch((cause: unknown) => {
        this.directories.set(path, { kind: "failed", reason: (cause as Error).message });
      })
      .then(() => {
        this.pendingReads.delete(read);
        this.reanchor();
        this.notify();
      });
    this.pendingReads.add(read);
  }
}

type DirectoryState =
  | { kind: "loading" }
  | { kind: "loaded"; entries: Entry[] }
  | { kind: "failed"; reason: string };

function loadOf(state: DirectoryState | undefined): Pick<BrowserRow, "load" | "failure"> {
  if (state?.kind === "loading") return { load: "loading", failure: undefined };
  if (state?.kind === "failed") return { load: "failed", failure: state.reason };
  return { load: "ready", failure: undefined };
}

function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
    return left.name.toLowerCase() < right.name.toLowerCase() ? -1 : 1;
  });
}

function isPrintable(chord: Chord): boolean {
  return chord.name.length === 1 && !chord.ctrl && !chord.meta;
}

function clampIndex(index: number, count: number): number {
  return Math.max(0, Math.min(index, count - 1));
}

function clampScroll(scrollTop: number, count: number, rows: number): number {
  return Math.max(0, Math.min(scrollTop, Math.max(0, count - rows)));
}
