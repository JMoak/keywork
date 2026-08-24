import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fuzzyScore } from "./commands.ts";
import type { Chord } from "./keys.ts";
import { failureMessage, PaneTasks } from "./pane-tasks.ts";
import { isPrintable } from "./picker-keys.ts";
import { RowCursor } from "./row-cursor.ts";

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

export class BrowserModel extends RowCursor<BrowserRow> {
  readonly name: string;
  showHidden = false;
  filterQuery = "";
  filtering = false;

  private readonly directories = new Map<string, DirectoryState>();
  private readonly expandedDirs = new Set<string>();
  private readonly tasks: PaneTasks;

  constructor(
    readonly rootPath: string,
    private readonly readDirectory: ReadDirectory,
    notify: () => void,
    private readonly openFile: (path: string) => void,
  ) {
    const tasks = new PaneTasks(notify);
    super(() => tasks.emit());
    this.tasks = tasks;
    this.name = basename(rootPath) || rootPath;
    this.expandedDirs.add(rootPath);
    this.load(rootPath);
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

  handleKey(chord: Chord, pageRows: number, sequence?: string): boolean {
    if (this.filtering) return this.handleFilterKey(chord, pageRows, sequence);
    if (chord.shift || chord.ctrl || chord.meta) return false;
    if (this.navigate(chord, pageRows)) return true;
    switch (chord.name) {
      case "h":
        return this.collapseOrJumpToParent();
      case "l":
      case "enter":
      case "return":
        return this.expandOrOpen();
      case ".":
        return this.mutate(() => {
          this.showHidden = !this.showHidden;
        });
      case "r":
        return this.mutate(() => this.reload());
      case "/":
        this.filtering = true;
        this.notify();
        return true;
      case "escape":
        if (this.filterQuery === "") return false;
        return this.clearFilter();
      default:
        return false;
    }
  }

  settled(): Promise<void> {
    return this.tasks.settled();
  }

  dispose(): void {
    this.tasks.dispose();
  }

  protected buildRows(): BrowserRow[] {
    const rows: BrowserRow[] = [];
    this.collect(this.rootPath, 0, rows);
    if (this.filterQuery === "") return rows;
    const query = this.filterQuery.toLowerCase();
    return rows.filter((row) => fuzzyScore(query, row.name.toLowerCase()) !== undefined);
  }

  protected keyOf(row: BrowserRow): string {
    return row.path;
  }

  private handleFilterKey(chord: Chord, pageRows: number, sequence: string | undefined): boolean {
    switch (chord.name) {
      case "escape":
        this.filtering = false;
        return this.clearFilter();
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
        return this.moveCursor(-1);
      case "down":
        return this.moveCursor(1);
      case "pageup":
        return this.moveCursor(-pageRows);
      case "pagedown":
        return this.moveCursor(pageRows);
      default:
        if (!isPrintable(chord, sequence)) return false;
        return this.mutate(() => {
          this.filterQuery += sequence;
        });
    }
  }

  private clearFilter(): true {
    return this.mutate(() => {
      this.filterQuery = "";
    });
  }

  private collapseOrJumpToParent(): boolean {
    const row = this.cursorRow();
    if (row === undefined) return true;
    if (row.kind === "dir" && this.expandedDirs.has(row.path)) {
      return this.mutate(() => this.expandedDirs.delete(row.path));
    }
    const parentAt = this.rows().findIndex((candidate) => candidate.path === dirname(row.path));
    if (parentAt >= 0) this.moveTo(parentAt);
    return true;
  }

  private expandOrOpen(): boolean {
    const row = this.cursorRow();
    if (row === undefined) return true;
    if (row.kind === "file") {
      this.openFile(row.path);
      return true;
    }
    if (this.expandedDirs.has(row.path)) return true;
    return this.mutate(() => {
      this.expandedDirs.add(row.path);
      this.load(row.path);
    });
  }

  private reload(): void {
    this.directories.clear();
    this.load(this.rootPath);
  }

  private collect(directoryPath: string, depth: number, out: BrowserRow[]): void {
    const state = this.directories.get(directoryPath);
    if (state?.kind !== "loaded") return;
    for (const entry of state.entries) {
      const hidden = entry.name.startsWith(".");
      if (hidden && !this.showHidden) continue;
      const path = join(directoryPath, entry.name);
      const expanded = entry.kind === "dir" && this.expandedDirs.has(path);
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

  private load(path: string): void {
    if (this.directories.has(path)) return;
    const claim: DirectoryState = { kind: "loading" };
    this.directories.set(path, claim);
    this.tasks.track(() =>
      this.readDirectory(path)
        .then((entries) =>
          this.settle(path, claim, { kind: "loaded", entries: sortEntries(entries) }),
        )
        .catch((cause: unknown) => {
          this.settle(path, claim, { kind: "failed", reason: failureMessage(cause) });
        }),
    );
  }

  private settle(path: string, claim: DirectoryState, state: DirectoryState): void {
    if (this.directories.get(path) !== claim) return;
    this.rebuild(() => {
      this.directories.set(path, state);
      if (state.kind === "loaded") this.loadExpandedChildren(path, state.entries);
    });
  }

  private loadExpandedChildren(directoryPath: string, entries: readonly Entry[]): void {
    for (const entry of entries) {
      const path = join(directoryPath, entry.name);
      if (entry.kind === "dir" && this.expandedDirs.has(path)) this.load(path);
    }
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
    return (
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
      left.name.localeCompare(right.name)
    );
  });
}
