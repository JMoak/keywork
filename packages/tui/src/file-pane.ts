import { Box, Text } from "@opentui/core";
import { FileModel } from "./file-model.ts";
import type { Chord } from "./keys.ts";
import type { Pane, PaneContext, PaneView } from "./pane.ts";
import type { Theme } from "./theme.ts";

export class FilePane implements Pane {
  private readonly model: FileModel;
  private lastPageRows = 20;

  constructor(
    readonly id: string,
    cwd: string,
    path: string,
    notify: () => void,
  ) {
    this.model = new FileModel(cwd, path, notify);
  }

  title(): string {
    const count = this.model.lineCount();
    return count === 0 ? ` ${this.model.name} ` : ` ${this.model.name} · ${count} lines `;
  }

  handleKey(chord: Chord): boolean {
    return this.model.handleKey(chord, this.lastPageRows);
  }

  view(context: PaneContext): PaneView {
    const { theme, focused, height, width } = context;
    this.lastPageRows = Math.max(3, height - 3);
    return Box(
      {
        flexGrow: 1,
        flexBasis: 0,
        border: true,
        borderStyle: "rounded",
        borderColor: focused ? theme.borderFocus : theme.border,
        title: this.title(),
        titleAlignment: "left",
        flexDirection: "column",
        paddingLeft: 1,
        paddingRight: 1,
      },
      ...this.bodyLines(theme, this.lastPageRows, Math.max(10, width - 4)),
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
