import { Box, Text } from "@opentui/core";
import { type GlyphSupport, resolveMark, type TieredMark } from "./capability.ts";
import { assumedGlyphs } from "./marks.ts";
import type { Theme } from "./theme.ts";
import { clip, padEnd, width } from "./width.ts";

export interface TrayItem {
  name: string;
  description: string;
  shortcut?: string;
}

export interface TrayStyle {
  namePrefix?: string;
  glyphs?: GlyphSupport;
}

export type TrayChild = ReturnType<typeof Box> | ReturnType<typeof Text>;

export function trayRows(
  items: readonly TrayItem[],
  selected: number,
  width: number,
  theme: Theme,
  style: TrayStyle = {},
): TrayChild[] {
  const prefix = style.namePrefix ?? "";
  const mark = resolveMark(selectionMark, style.glyphs ?? assumedGlyphs);
  const column = nameColumnWidth(items, prefix);
  return items.map((item, index) =>
    trayRow(item, index === selected ? mark : " ", column, width, theme, prefix),
  );
}

export function trayBox(theme: Theme, rows: readonly TrayChild[]): TrayChild {
  return Box(
    {
      border: true,
      borderStyle: "rounded",
      borderColor: theme.accentSoft,
      flexDirection: "column",
      overflow: "hidden",
    },
    ...rows,
  );
}

export function clipLine(text: string, cells: number): string {
  return clip(text, cells);
}

const selectionMark = { tier1: "▸", tier0: ">" } satisfies TieredMark;
const nameColumnCap = 24;
const markerCells = 5;

function nameColumnWidth(items: readonly TrayItem[], prefix: string): number {
  const longest = items.reduce((widest, item) => Math.max(widest, width(item.name)), 0);
  return Math.min(nameColumnCap, longest + width(prefix));
}

function trayRow(
  item: TrayItem,
  marker: string,
  column: number,
  rowWidth: number,
  theme: Theme,
  prefix: string,
): TrayChild {
  const selected = marker !== " ";
  const shortcut = clip(item.shortcut === undefined ? " " : `${item.shortcut} `, rowWidth);
  const nameRoom = Math.max(0, rowWidth - width(shortcut));
  const name = clip(padEnd(` ${marker} ${prefix}${item.name}`, column + markerCells), nameRoom);
  const room = Math.max(0, rowWidth - width(name) - width(shortcut));
  return Box(
    { flexDirection: "row", height: 1, overflow: "hidden" },
    Text({ content: name, fg: selected ? theme.accent : theme.text }),
    Text({
      content: padEnd(clip(item.description, room), room),
      fg: selected ? theme.text : theme.textDim,
    }),
    Text({ content: shortcut, fg: theme.textDim }),
  );
}
