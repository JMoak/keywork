import {
  type BorderCharacters,
  type BorderStyle,
  Box,
  bg,
  fg,
  StyledText,
  Text,
  type TextChunk,
} from "@opentui/core";
import {
  border as borderMarks,
  type GlyphSupport,
  resolveMark,
  type TieredMark,
} from "./capability.ts";
import { type LifecycleChrome, lifecycleChrome, rampColor } from "./chroma.ts";
import { type Chord, parseChord } from "./keys.ts";
import { assumedGlyphs } from "./marks.ts";
import type { ChromeWeight, LifecycleState, PaneContext, PaneView } from "./pane.ts";
import type { TrayCommand } from "./pane-tray.ts";
import type { RowCursor } from "./row-cursor.ts";
import { slugInk, slugParts } from "./slug.ts";
import type { Theme, ThemeColorToken } from "./theme.ts";
import { isLabelZone, type TitleSpan } from "./title-bar.ts";
import { clipSpans, padEnd, take, width } from "./width.ts";

export type PaneChild = Parameters<typeof Box>[1];

export type RowTone = "dim" | "normal" | "heading" | "alert";

export interface RowPaint<Row> {
  text(row: Row): string;
  line(row: Row): PaneChild;
  selected?(row: Row): PaneChild | undefined;
  empty?: string;
}

export interface KeyedTrayCommand {
  name: string;
  description: string;
  key: string;
}

export interface PaneTitle {
  readonly spans: readonly TitleSpan[];
  readonly state: LifecycleState;
  readonly arrival?: number | undefined;
  readonly groundArrival?: number | undefined;
}

const borderCells = 1;
const headerRows = 1;
const paddingCells = { left: 1, right: 1 };
const boxedTitleColumn = 2;

interface ChromeCost {
  readonly columns: number;
  readonly rows: number;
}

const boxedCost: ChromeCost = {
  columns: 2 * borderCells + paddingCells.left + paddingCells.right,
  rows: 2 * borderCells,
};

const headedCost: ChromeCost = {
  columns: paddingCells.left + paddingCells.right,
  rows: headerRows,
};

export const paneChromeCost = boxedCost;

export interface ChromeExtent {
  width: number;
  height: number;
  chrome?: ChromeWeight;
}

export function paneContentWidth(extent: Pick<ChromeExtent, "width" | "chrome">): number {
  return Math.max(0, extent.width - chromeCostOf(extent.chrome).columns);
}

export function paneContentHeight(extent: Pick<ChromeExtent, "height" | "chrome">): number {
  return Math.max(0, extent.height - chromeCostOf(extent.chrome).rows);
}

export function isSeamed(chrome: ChromeWeight | undefined): boolean {
  return chrome === "seams";
}

export function isBorderless(chrome: ChromeWeight | undefined): boolean {
  return chrome === "borderless";
}

export function hasHeaderRow(chrome: ChromeWeight | undefined): boolean {
  return isSeamed(chrome) || isBorderless(chrome);
}

export function paneChrome(
  context: PaneContext,
  title: string | PaneTitle,
  ...children: PaneChild[]
): PaneView {
  const composed = typeof title === "string" ? plainTitle(title) : title;
  const inks = paneInks(context, composed);
  return hasHeaderRow(context.chrome)
    ? headedChrome(context, composed, inks, children)
    : boxedChrome(context, composed, inks, children);
}

export function paneInks(context: PaneContext, title: Pick<PaneTitle, "state">): LifecycleChrome {
  const { theme, focused } = context;
  const hue = context.hue ?? rampColor(theme.ramp, 0);
  return lifecycleChrome(title.state, focused, hue, theme);
}

export function paneTitle(name: string, detail?: string): string {
  return detail === undefined ? ` ${name} ` : ` ${name} · ${detail} `;
}

export const focusMark = { tier1: "▎", tier0: ">" } satisfies TieredMark;

export function rowsView<Row>(
  list: Pick<RowCursor<Row>, "visibleRows">,
  rowCount: number,
  theme: Theme,
  width: number,
  paint: RowPaint<Row>,
): PaneChild[] {
  const visible = list.visibleRows(rowCount);
  if (visible.length === 0) {
    return paint.empty === undefined ? [] : [paneLine(paint.empty, theme.textDim, width)];
  }
  return visible.map(({ row, selected }) => {
    if (!selected) return paint.line(row);
    return paint.selected?.(row) ?? selectedLine(paint.text(row), theme, width);
  });
}

export function selectedLine(content: string, theme: Theme, width: number): PaneChild {
  return Text({
    content: padEnd(take(content, width), width),
    fg: theme.background,
    bg: theme.accent,
  });
}

export function paneLine(content: string, ink: string, width: number): PaneChild {
  return Text({ content: take(content, width), fg: ink });
}

export function paneFailureLine(failure: string, theme: Theme, width: number): PaneChild {
  return paneLine(failure, theme.error, width);
}

export function toneInk(theme: Theme, tone: RowTone): string {
  return theme[toneTokens[tone]];
}

export function trayCommandsPressing(
  press: (chord: Chord) => unknown,
  commands: readonly KeyedTrayCommand[],
): TrayCommand[] {
  return commands.map(({ name, description, key }) => ({
    name,
    description,
    shortcut: shortcutGlyph(key),
    run: () => press(parseChord(key)),
  }));
}

function chromeCostOf(chrome: ChromeWeight | undefined): ChromeCost {
  return hasHeaderRow(chrome) ? headedCost : boxedCost;
}

function plainTitle(title: string): PaneTitle {
  return { spans: [{ text: title.trim(), zone: "name" }], state: "idle" };
}

function boxedChrome(
  context: PaneContext,
  title: PaneTitle,
  inks: LifecycleChrome,
  children: PaneChild[],
): PaneView {
  const { width, height, theme } = context;
  const room = Math.max(0, width - boxedCost.columns);
  return Box(
    { width, height, flexDirection: "column", overflow: "hidden" },
    Box(
      {
        flexGrow: 1,
        border: true,
        ...borderGlyphs(glyphsOf(context)),
        borderColor: borderInk(context, title, inks),
        flexDirection: "column",
        overflow: "hidden",
        paddingLeft: paddingCells.left,
        paddingRight: paddingCells.right,
      },
      ...children,
    ),
    placedRow(titleRow(context, title, inks, room, theme.background)),
  );
}

function placedRow(row: StyledText) {
  const cells = row.chunks.reduce((total, chunk) => total + width(chunk.text), 0);
  return Text({
    position: "absolute",
    left: boxedTitleColumn,
    top: 0,
    width: cells,
    zIndex: 1,
    content: row,
  });
}

function headedChrome(
  context: PaneContext,
  title: PaneTitle,
  inks: LifecycleChrome,
  children: PaneChild[],
): PaneView {
  const { width, height, theme } = context;
  const lifted = isBorderless(context.chrome) && context.focused;
  return Box(
    {
      width,
      height,
      flexDirection: "column",
      overflow: "hidden",
      ...(lifted && { backgroundColor: theme.panel }),
    },
    Text({ content: titleRow(context, title, inks, Math.max(0, width - paddingCells.right)) }),
    Box(
      {
        flexGrow: 1,
        flexDirection: "column",
        overflow: "hidden",
        paddingLeft: paddingCells.left,
        paddingRight: paddingCells.right,
      },
      ...children,
    ),
  );
}

function borderInk(context: PaneContext, title: PaneTitle, inks: LifecycleChrome): string {
  const arrival = title.arrival;
  if (arrival === undefined) return inks.borderColor;
  return rampColor([context.theme.border, inks.borderColor], arrival);
}

interface BorderGlyphs {
  readonly borderStyle: BorderStyle;
  readonly customBorderChars?: BorderCharacters;
}

function borderGlyphs(glyphs: GlyphSupport): BorderGlyphs {
  if (glyphs.glyphTier >= 1) return { borderStyle: "rounded" };
  const mark = (name: keyof typeof borderMarks): string => resolveMark(borderMarks[name], glyphs);
  const corner = mark("topLeft");
  return {
    borderStyle: "single",
    customBorderChars: {
      topLeft: corner,
      topRight: mark("topRight"),
      bottomLeft: mark("bottomLeft"),
      bottomRight: mark("bottomRight"),
      horizontal: mark("horizontal"),
      vertical: mark("vertical"),
      topT: corner,
      bottomT: corner,
      leftT: corner,
      rightT: corner,
      cross: corner,
    },
  };
}

function glyphsOf(context: PaneContext): GlyphSupport {
  return context.glyphs ?? assumedGlyphs;
}

interface RowSpan {
  readonly text: string;
  readonly fg: string;
  readonly bg?: string | undefined;
}

function titleRow(
  context: PaneContext,
  title: PaneTitle,
  inks: LifecycleChrome,
  room: number,
  rowGround?: string,
): StyledText {
  const { theme } = context;
  const label = title.spans.slice(0, labelEnd(title.spans) + 1);
  const tail = title.spans.slice(label.length);
  const head: RowSpan[] = [
    { text: leadCell(context), fg: inks.labelInk },
    ...(context.pinMark === undefined ? [] : [{ text: `${context.pinMark} `, fg: theme.textDim }]),
  ];
  const row: RowSpan[] = [
    ...head,
    ...label.flatMap((span) => labelSpans(span, inks.labelInk, theme)),
    ...tail.map((span) => ({ text: span.text, fg: tailInk(span, theme) })),
    { text: " ", fg: inks.labelInk },
  ].map((span) => ({ ...span, bg: rowGround }));
  const ground = groundInk(context, title, inks);
  const painted =
    ground === undefined
      ? row
      : paintGround(
          row,
          { from: cellsOf(head) - 1, to: cellsOf(head) + cellsOf(label) + 1 },
          ground,
          theme,
        );
  return new StyledText(clipSpans(painted, room).map(chunkOf));
}

function leadCell(context: PaneContext): string {
  if (!isBorderless(context.chrome) || !context.focused) return " ";
  return resolveMark(focusMark, glyphsOf(context));
}

function labelEnd(spans: readonly TitleSpan[]): number {
  return spans.findLastIndex((span) => isLabelZone(span.zone));
}

function cellsOf(spans: readonly { text: string }[]): number {
  return spans.reduce((total, span) => total + width(span.text), 0);
}

function labelSpans(span: TitleSpan, ink: string, theme: Theme): RowSpan[] {
  if (span.zone !== "slug") return [{ text: span.text, fg: ink }];
  const inks = slugInk(theme, ink);
  return slugParts(span.text).map((part) => ({ text: part.text, fg: inks[part.role] }));
}

function tailInk(span: TitleSpan, theme: Theme): string {
  return span.zone === "telemetry" ? theme.textMid : theme.textDim;
}

function groundInk(
  context: PaneContext,
  title: PaneTitle,
  inks: LifecycleChrome,
): string | undefined {
  if (inks.labelGround === undefined) return undefined;
  const arrival = title.groundArrival;
  if (arrival === undefined) return inks.labelGround;
  return rampColor([context.theme.border, inks.labelGround], arrival);
}

interface CellRange {
  readonly from: number;
  readonly to: number;
}

function paintGround(row: RowSpan[], range: CellRange, ground: string, theme: Theme): RowSpan[] {
  const painted: RowSpan[] = [];
  let at = 0;
  for (const span of row) {
    for (const piece of splitAt(span, [range.from - at, range.to - at])) {
      const inside = at >= range.from && at < range.to;
      painted.push(inside ? { text: piece.text, fg: theme.background, bg: ground } : piece);
      at += width(piece.text);
    }
  }
  return painted;
}

function splitAt(span: RowSpan, cuts: readonly number[]): RowSpan[] {
  const pieces: RowSpan[] = [];
  let rest = span.text;
  let consumed = 0;
  for (const cut of cuts) {
    const head = take(rest, cut - consumed);
    if (head === "" || head === rest) continue;
    pieces.push({ ...span, text: head });
    consumed += width(head);
    rest = rest.slice(head.length);
  }
  if (rest !== "") pieces.push({ ...span, text: rest });
  return pieces;
}

function chunkOf(span: RowSpan): TextChunk {
  const chunk = fg(span.fg)(span.text);
  return span.bg === undefined ? chunk : bg(span.bg)(chunk);
}

const toneTokens: Record<RowTone, ThemeColorToken> = {
  dim: "textDim",
  normal: "text",
  heading: "accentSoft",
  alert: "error",
};

function shortcutGlyph(key: string): string {
  if (key === "enter") return "⏎";
  if (key === "escape") return "esc";
  return key.startsWith("shift+") ? key.slice("shift+".length).toUpperCase() : key;
}
