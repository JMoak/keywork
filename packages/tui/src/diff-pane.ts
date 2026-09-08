import { Text } from "@opentui/core";
import { type ChangedFile, type DiffBody, DiffModel, type DiffSeams } from "./diff-model.ts";
import type { DiffLine } from "./diff-render.ts";
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
import { take } from "./width.ts";

export class DiffPane implements Pane {
  private readonly model: DiffModel;
  private lastBodyRows = 20;

  constructor(
    readonly id: string,
    notify: () => void,
    intents: PaneIntents,
    seams: DiffSeams,
  ) {
    this.model = new DiffModel(seams, notify, (path, line) =>
      intents.openFile(path, line === undefined ? undefined : { line }),
    );
  }

  title(): string {
    const files = this.model.changedFiles();
    if (files.length === 0) return paneTitle("diff");
    const { added, deleted } = this.model.totals();
    return paneTitle("diff", `${countText(files.length, "file")} · +${added} -${deleted}`);
  }

  describe(): PaneDescriptor {
    return { kind: "diff" };
  }

  handleKey(chord: Chord): boolean {
    return this.model.handleKey(chord, this.lastBodyRows);
  }

  settled(): Promise<void> {
    return this.model.settled();
  }

  dispose(): void {
    this.model.dispose();
  }

  view(context: PaneContext): PaneView {
    const height = paneContentHeight(context);
    const width = paneContentWidth(context);
    const listRows = fileListRows(this.model.changedFiles().length, height);
    this.lastBodyRows = Math.max(0, height - listRows - 1);
    return paneChrome(
      context,
      this.title(),
      ...this.fileLines(context.theme, listRows, width),
      ...this.bodyLines(context.theme, this.lastBodyRows, width),
    );
  }

  private fileLines(theme: Theme, rows: number, width: number): PaneChild[] {
    if (rows === 0) return [];
    return rowsView(this.model, rows, theme, width, {
      empty: emptyText(this.model.body(), this.model.baselineLabel()),
      text: fileRowText,
      line: (row) => paneLine(fileRowText(row), theme.text, width),
    });
  }

  private bodyLines(theme: Theme, rows: number, width: number): PaneChild[] {
    if (rows === 0) return [];
    const body = this.model.body();
    const rule = paneLine("─".repeat(width), theme.border, width);
    if (body.kind === "unavailable") return [rule, paneLine(body.reason, theme.textDim, width)];
    if (body.kind === "failed") return [rule, paneFailureLine(body.reason, theme, width)];
    if (body.kind === "loading") return [rule, paneLine("loading…", theme.textDim, width)];
    if (body.kind === "empty") return [rule];
    return [rule, ...this.model.visibleBody(rows).map((line) => diffRow(line, theme, width))];
  }
}

export function fileRowText(file: ChangedFile): string {
  const turn = file.turn === undefined ? "" : ` · turn ${file.turn}`;
  return `${file.path}  +${file.added} -${file.deleted}${turn}`;
}

const minimumListRows = 3;

function fileListRows(fileCount: number, height: number): number {
  const share = Math.max(minimumListRows, Math.floor(height / 3));
  return Math.min(Math.max(1, fileCount), share, Math.max(0, height - 1));
}

function emptyText(body: DiffBody, baseline: string | undefined): string {
  if (body.kind === "unavailable") return "no baseline";
  if (body.kind === "loading") return "loading…";
  if (body.kind === "failed") return "couldn't read changes";
  return baseline === undefined ? "no changes" : `no changes since ${baseline}`;
}

function diffRow(line: DiffLine, theme: Theme, width: number): PaneChild {
  switch (line.kind) {
    case "add":
      return Text({ content: take(`+ ${line.text}`, width), fg: theme.success });
    case "del":
      return Text({ content: take(`- ${line.text}`, width), fg: theme.error });
    case "context":
      return Text({ content: take(`  ${line.text}`, width), fg: theme.text });
    case "hunk":
      return Text({ content: take(line.text, width), fg: theme.textDim });
    case "note":
      return Text({ content: take(`· ${line.text}`, width), fg: theme.textDim });
  }
}

function countText(count: number, noun: string): string {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}
