import { Box, Text } from "@opentui/core";
import { type Chord, parseChord } from "./keys.ts";
import type { ChromeWeight, PaneContext, PaneView } from "./pane.ts";
import type { TrayCommand } from "./pane-tray.ts";
import type { RowCursor } from "./row-cursor.ts";
import type { Theme, ThemeColorToken } from "./theme.ts";
import { padEnd, take } from "./width.ts";

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

const borderCells = 1;
const headerRows = 1;
const paddingCells = { left: 1, right: 1 };

interface ChromeCost {
  readonly columns: number;
  readonly rows: number;
}

const boxedCost: ChromeCost = {
  columns: 2 * borderCells + paddingCells.left + paddingCells.right,
  rows: 2 * borderCells,
};

const seamedCost: ChromeCost = {
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

export function paneChrome(
  context: PaneContext,
  title: string,
  ...children: PaneChild[]
): PaneView {
  return isSeamed(context.chrome)
    ? seamedChrome(context, title, children)
    : boxedChrome(context, title, children);
}

function chromeCostOf(chrome: ChromeWeight | undefined): ChromeCost {
  return isSeamed(chrome) ? seamedCost : boxedCost;
}

function boxedChrome(context: PaneContext, title: string, children: PaneChild[]): PaneView {
  const { theme, focused, width, height, borderColor, pinMark } = context;
  return Box(
    {
      width,
      height,
      border: true,
      borderStyle: "rounded",
      borderColor: borderColor ?? (focused ? theme.borderFocus : theme.border),
      title: pinMark === undefined ? title : ` ${pinMark}${title}`,
      titleAlignment: "left",
      flexDirection: "column",
      overflow: "hidden",
      paddingLeft: paddingCells.left,
      paddingRight: paddingCells.right,
    },
    ...children,
  );
}

function seamedChrome(context: PaneContext, title: string, children: PaneChild[]): PaneView {
  const { theme, focused, width, height, borderColor, pinMark } = context;
  const label = pinMark === undefined ? title.trim() : `${pinMark} ${title.trim()}`;
  return Box(
    {
      width,
      height,
      flexDirection: "column",
      overflow: "hidden",
      paddingLeft: paddingCells.left,
      paddingRight: paddingCells.right,
    },
    Text({
      content: take(label, paneContentWidth(context)) || " ",
      fg: focused ? (borderColor ?? theme.borderFocus) : theme.textMid,
    }),
    ...children,
  );
}

export function paneTitle(name: string, detail?: string): string {
  return detail === undefined ? ` ${name} ` : ` ${name} · ${detail} `;
}

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
