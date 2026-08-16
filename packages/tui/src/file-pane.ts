import { Text } from "@opentui/core";
import { FileModel } from "./file-model.ts";
import type { Chord } from "./keys.ts";
import type { FileOpenOptions, Pane, PaneContext, PaneDescriptor, PaneView } from "./pane.ts";
import { paneChrome, paneContentHeight, paneContentWidth, paneTitle } from "./pane-chrome.ts";
import type { Theme } from "./theme.ts";

export class FilePane implements Pane {
  private readonly model: FileModel;
  private lastPageRows = 20;

  constructor(
    readonly id: string,
    cwd: string,
    path: string,
    notify: () => void,
    options: FileOpenOptions = {},
  ) {
    this.model = new FileModel(cwd, path, notify, options);
  }

  title(): string {
    const count = this.model.lineCount();
    return paneTitle(this.model.name, count === 0 ? undefined : `${count} lines`);
  }

  describe(): PaneDescriptor {
    return { kind: "file", path: this.model.path };
  }

  handleKey(chord: Chord): boolean {
    return this.model.handleKey(chord, this.lastPageRows);
  }

  view(context: PaneContext): PaneView {
    const { theme, height, width } = context;
    this.lastPageRows = paneContentHeight(height);
    return paneChrome(
      context,
      this.title(),
      ...this.bodyLines(theme, this.lastPageRows, paneContentWidth(width)),
    );
  }

  private bodyLines(theme: Theme, rows: number, width: number) {
    const state = this.model.state;
    if (state.kind === "loading") return [Text({ content: "loading…", fg: theme.textDim })];
    if (state.kind === "failed") {
      return [Text({ content: `${this.model.path}: ${state.reason}`, fg: theme.error })];
    }
    const gutter = String(this.model.lineCount()).length;
    return this.model.visibleLines(rows).map((line) =>
      Text({
        content: `${String(line.number).padStart(gutter)} ${line.text}`.slice(0, width),
        fg: theme.text,
      }),
    );
  }
}
