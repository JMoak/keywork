import { fg, StyledText, Text } from "@opentui/core";
import {
  type ChangedFile,
  type DiffBody,
  type DiffFile,
  DiffModel,
  type DiffSeams,
  type HunkPlace,
} from "./diff-model.ts";
import type { DiffLine } from "./diff-render.ts";
import type { Chord } from "./keys.ts";
import type { Palette } from "./palette.ts";
import type { Pane, PaneContext, PaneDescriptor, PaneIntents, PaneView } from "./pane.ts";
import {
  type PaneChild,
  paneChrome,
  paneContentHeight,
  paneContentWidth,
  paneLine,
  paneTitle,
  rowsView,
  selectedLine,
  wrappedLines,
} from "./pane-chrome.ts";
import { pluralize } from "./pluralize.ts";
import { width as cells, clipSpans, clipStart, padEnd, take, wrapPhrases } from "./width.ts";

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
    return paneTitle("diff", `${pluralize(files.length, "file")} · +${added} -${deleted}`);
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
    this.model.followTurns();
    const height = paneContentHeight(context);
    const width = paneContentWidth(context);
    const listRows = fileListRows(this.model.changedFiles().length, height);
    const rule = this.ruleLines(context.theme, width);
    this.lastBodyRows = Math.max(0, height - listRows - rule.length);
    return paneChrome(
      context,
      this.title(),
      ...this.fileLines(context.theme, listRows, width),
      ...this.bodyLines(context.theme, this.lastBodyRows, width, rule),
    );
  }

  private fileLines(theme: Palette, rows: number, width: number): PaneChild[] {
    if (rows === 0) return [];
    const files = this.model.changedFiles();
    const column = groupColumn(files);
    const visible = this.model.visibleRows(rows);
    const firstShown = visible[0]?.index ?? 0;
    const labelled = (file: DiffFile, index: number) =>
      index === firstShown || files[index - 1]?.group !== file.group;
    return rowsView(this.model, rows, theme, width, {
      empty: emptyText(this.model.body(), this.model.baselineLabel()),
      text: (file) => groupedRowText(file, column, true, width),
      line: (file) =>
        groupedRowView(file, column, labelled(file, files.indexOf(file)), theme, width),
      selected: (file) => selectedLine(groupedRowText(file, column, true, width), theme, width),
    });
  }

  private bodyLines(
    theme: Palette,
    rows: number,
    width: number,
    rule: readonly PaneChild[],
  ): PaneChild[] {
    if (rows === 0) return [];
    const body = this.model.body();
    if (body.kind === "unavailable")
      return [...rule, ...wrappedLines(body.reason, theme.textDim, width)];
    if (body.kind === "failed") return [...rule, ...wrappedLines(body.reason, theme.error, width)];
    if (body.kind === "loading") return [...rule, paneLine("loading…", theme.textDim, width)];
    if (body.kind === "empty") return [...rule];
    const cursor = this.model.hunk()?.line;
    const top = this.model.bodyScrollTop;
    return [
      ...rule,
      ...this.model
        .visibleBody(rows)
        .map((line, at) => diffRow(line, theme, width, top + at === cursor)),
    ];
  }

  private ruleLines(theme: Palette, width: number): PaneChild[] {
    const question = this.model.pendingQuestion();
    if (question !== undefined) return ruleRows(question, theme.accent, theme, width);
    const place = hunkPlace(this.model.hunk(), this.model.hunkCount());
    const keys = diffKeyHint(this.model.undoReach());
    return ruleRows(place === "" ? keys : `${place} · ${keys}`, theme.textDim, theme, width);
  }
}

export function fileRowText(file: ChangedFile, room = Number.POSITIVE_INFINITY): string {
  const turn = file.turn === undefined ? "" : ` · turn ${file.turn}`;
  return `${fileCounts(file, room - cells(turn))}${turn}`;
}

function fileCounts(file: ChangedFile, room = Number.POSITIVE_INFINITY): string {
  const counts = `+${file.added} -${file.deleted}`;
  const pathRoom = Math.max(1, room - cells(countsGap) - cells(counts));
  return `${clipStart(file.path, pathRoom)}${countsGap}${counts}`;
}

const countsGap = "  ";

export function diffKeyHint(undoReach: string): string {
  return `n p hunks · u undoes ${undoReach} · shift+u redoes · enter opens`;
}

function groupColumn(files: readonly DiffFile[]): number {
  return files.reduce((widest, file) => Math.max(widest, cells(file.group)), 0);
}

function groupedRowText(file: DiffFile, column: number, labelled: boolean, width: number): string {
  if (column === 0) return fileRowText(file, width);
  const label = labelled ? file.group : "";
  return `${padEnd(label, column)}${groupGap}${fileCounts(file, width - column - cells(groupGap))}`;
}

const groupGap = "  ";

function groupedRowView(
  file: DiffFile,
  column: number,
  labelled: boolean,
  theme: Palette,
  width: number,
): PaneChild {
  if (column === 0) return paneLine(fileRowText(file, width), theme.text, width);
  const label = padEnd(labelled ? file.group : "", column);
  const counts = fileCounts(file, width - column - cells(groupGap));
  return Text({
    content: new StyledText(
      clipSpans([fg(theme.textMid)(`${label}${groupGap}`), fg(theme.text)(counts)], width),
    ),
  });
}

function hunkPlace(hunk: HunkPlace | undefined, count: number): string {
  if (count === 0) return "";
  return hunk === undefined ? pluralize(count, "hunk") : `hunk ${hunk.ordinal} of ${count}`;
}

function ruleRows(text: string, ink: string, theme: Palette, width: number): PaneChild[] {
  const hang = " ".repeat(cells(ruleLead) + 1);
  const [first = "", ...rest] = wrapPhrases(text, Math.max(1, width - cells(hang) - 1));
  return [
    ruleRow(first, ink, theme, width),
    ...rest.map((line) => Text({ content: `${hang}${line}`, fg: ink })),
  ];
}

const ruleLead = "──";

function ruleRow(text: string, ink: string, theme: Palette, width: number): PaneChild {
  const label = ` ${text} `;
  const rest = Math.max(0, width - cells(ruleLead) - cells(label));
  return Text({
    content: new StyledText(
      clipSpans(
        [fg(theme.border)(ruleLead), fg(ink)(label), fg(theme.border)("─".repeat(rest))],
        width,
      ),
    ),
  });
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

function diffRow(line: DiffLine, theme: Palette, width: number, cursored: boolean): PaneChild {
  switch (line.kind) {
    case "add":
      return Text({ content: take(`+ ${line.text}`, width), fg: theme.success });
    case "del":
      return Text({ content: take(`- ${line.text}`, width), fg: theme.error });
    case "context":
      return Text({ content: take(`  ${line.text}`, width), fg: theme.text });
    case "hunk":
      return cursored
        ? Text({ content: take(`▸ ${line.text}`, width), fg: theme.accent })
        : Text({ content: take(line.text, width), fg: theme.textDim });
    case "note":
      return Text({ content: take(`· ${line.text}`, width), fg: theme.textDim });
  }
}
