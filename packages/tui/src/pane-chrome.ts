import { Box, Text } from "@opentui/core";
import { type Chord, parseChord } from "./keys.ts";
import type { PaneContext, PaneView } from "./pane.ts";
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
const paddingCells = { left: 1, right: 1 };

export const paneChromeCost = {
  columns: 2 * borderCells + paddingCells.left + paddingCells.right,
  rows: 2 * borderCells,
} as const;

export function paneContentWidth(paneWidth: number): number {
  return Math.max(0, paneWidth - paneChromeCost.columns);
}

export function paneContentHeight(paneHeight: number): number {
  return Math.max(0, paneHeight - paneChromeCost.rows);
}

export function paneChrome(
  context: PaneContext,
  title: string,
  ...children: PaneChild[]
): PaneView {
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
