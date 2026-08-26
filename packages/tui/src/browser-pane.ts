import {
  BrowserModel,
  type BrowserRow,
  type ReadDirectory,
  readDirectoryFromDisk,
} from "./browser-model.ts";
import type { Chord } from "./keys.ts";
import type { Pane, PaneContext, PaneDescriptor, PaneIntents, PaneView } from "./pane.ts";
import {
  type PaneChild,
  paneChrome,
  paneContentHeight,
  paneContentWidth,
  paneFailureLine,
  paneLine,
  paneTitle,
  rowsView,
} from "./pane-chrome.ts";
import type { Theme } from "./theme.ts";

export class BrowserPane implements Pane {
  private readonly model: BrowserModel;
  private lastPageRows = 20;

  constructor(
    readonly id: string,
    rootPath: string,
    notify: () => void,
    intents: PaneIntents,
    readDirectory: ReadDirectory = readDirectoryFromDisk,
  ) {
    this.model = new BrowserModel(rootPath, readDirectory, notify, (path) =>
      intents.openFile(path),
    );
  }

  title(): string {
    const count = this.model.entryCount();
    return paneTitle(this.model.name, count === 0 ? undefined : `${count} entries`);
  }

  describe(): PaneDescriptor {
    return { kind: "browser", root: this.model.rootPath };
  }

  handleKey(chord: Chord, sequence?: string): boolean {
    return this.model.handleKey(chord, this.lastPageRows, sequence);
  }

  settled(): Promise<void> {
    return this.model.settled();
  }

  dispose(): void {
    this.model.dispose();
  }

  view(context: PaneContext): PaneView {
    const { theme, focused } = context;
    const filterLine = this.filterLine(theme, focused);
    this.lastPageRows = Math.max(
      0,
      paneContentHeight(context) - (filterLine === undefined ? 0 : 1),
    );
    return paneChrome(
      context,
      this.title(),
      ...this.bodyLines(theme, this.lastPageRows, paneContentWidth(context)),
      ...(filterLine === undefined ? [] : [filterLine]),
    );
  }

  private bodyLines(theme: Theme, rows: number, width: number): PaneChild[] {
    const failure = this.model.rootFailure();
    if (failure !== undefined) {
      return [paneFailureLine(`${this.model.rootPath}: ${failure}`, theme, width)];
    }
    if (this.model.rootLoading()) return [paneLine("loading…", theme.textDim, width)];
    return rowsView(this.model, rows, theme, width, {
      empty: "no entries",
      text: rowText,
      line: (row) => paneLine(rowText(row), rowInk(row, theme), width),
    });
  }

  private filterLine(theme: Theme, focused: boolean) {
    const { filtering, filterQuery } = this.model;
    if (!filtering && filterQuery === "") return undefined;
    const caret = filtering && focused ? "▌" : "";
    return paneLine(`/${filterQuery}${caret}`, theme.accent, Number.POSITIVE_INFINITY);
  }
}

function rowText(row: BrowserRow): string {
  const indent = "  ".repeat(row.depth);
  const affordance = row.kind === "dir" ? (row.expanded ? "▾ " : "▸ ") : "  ";
  const suffix = row.load === "loading" ? " …" : row.load === "failed" ? ` ✗ ${row.failure}` : "";
  return `${indent}${affordance}${row.name}${suffix}`;
}

function rowInk(row: BrowserRow, theme: Theme): string {
  if (row.load === "failed") return theme.error;
  if (row.hidden) return theme.textDim;
  return row.kind === "dir" ? theme.accentSoft : theme.text;
}
