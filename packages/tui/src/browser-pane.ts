import { Text } from "@opentui/core";
import {
  BrowserModel,
  type BrowserRow,
  type ReadDirectory,
  readDirectoryFromDisk,
} from "./browser-model.ts";
import type { Chord } from "./keys.ts";
import type { Pane, PaneContext, PaneDescriptor, PaneIntents, PaneView } from "./pane.ts";
import { paneChrome, paneTitle } from "./pane-chrome.ts";
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

  handleKey(chord: Chord): boolean {
    return this.model.handleKey(chord, this.lastPageRows);
  }

  settled(): Promise<void> {
    return this.model.settled();
  }

  view(context: PaneContext): PaneView {
    const { theme, focused, height, width } = context;
    const filterLine = this.filterLine(theme, focused);
    this.lastPageRows = Math.max(3, height - 3 - (filterLine === undefined ? 0 : 1));
    return paneChrome(
      context,
      this.title(),
      ...this.bodyLines(theme, this.lastPageRows, Math.max(10, width - 4)),
      ...(filterLine === undefined ? [] : [filterLine]),
    );
  }

  private bodyLines(theme: Theme, rows: number, width: number) {
    const failure = this.model.rootFailure();
    if (failure !== undefined) {
      return [
        Text({ content: `${this.model.rootPath}: ${failure}`.slice(0, width), fg: theme.error }),
      ];
    }
    if (this.model.rootLoading()) return [Text({ content: "loading…", fg: theme.textDim })];
    const visible = this.model.visibleRows(rows);
    if (visible.length === 0) return [Text({ content: "no entries", fg: theme.textDim })];
    return visible.map(({ index, row }) =>
      this.rowLine(row, index === this.model.cursor, theme, width),
    );
  }

  private rowLine(row: BrowserRow, selected: boolean, theme: Theme, width: number) {
    const content = rowText(row).slice(0, width);
    if (selected) {
      return Text({ content: content.padEnd(width), fg: theme.background, bg: theme.accent });
    }
    return Text({ content, fg: rowColor(row, theme) });
  }

  private filterLine(theme: Theme, focused: boolean) {
    const { filtering, filterQuery } = this.model;
    if (!filtering && filterQuery === "") return undefined;
    const caret = filtering && focused ? "▌" : "";
    return Text({ content: `/${filterQuery}${caret}`, fg: theme.accent });
  }
}

function rowText(row: BrowserRow): string {
  const indent = "  ".repeat(row.depth);
  const affordance = row.kind === "dir" ? (row.expanded ? "▾ " : "▸ ") : "  ";
  const suffix = row.load === "loading" ? " …" : row.load === "failed" ? ` ✗ ${row.failure}` : "";
  return `${indent}${affordance}${row.name}${suffix}`;
}

function rowColor(row: BrowserRow, theme: Theme): string {
  if (row.load === "failed") return theme.error;
  if (row.hidden) return theme.textDim;
  return row.kind === "dir" ? theme.accentSoft : theme.text;
}
