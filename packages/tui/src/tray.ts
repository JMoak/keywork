import { Box, Text } from "@opentui/core";
import { type GlyphSupport, resolveMark, type TieredMark } from "./capability.ts";
import { assumedGlyphs } from "./marks.ts";
import type { Palette } from "./palette.ts";
import { clip, clipStart, padEnd, width } from "./width.ts";

export interface TrayItem {
  name: string;
  description: string;
  shortcut?: string;
  jump?: true;
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
  theme: Palette,
  style: TrayStyle = {},
): TrayChild[] {
  const prefix = style.namePrefix ?? "";
  const mark = resolveMark(selectionMark, style.glyphs ?? assumedGlyphs);
  const column = nameColumnWidth(items, prefix, width);
  return items.map((item, index) =>
    trayRow(item, index === selected ? mark : " ", column, width, theme, prefix),
  );
}

export function trayBox(theme: Palette, rows: readonly TrayChild[]): TrayChild {
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

function nameColumnWidth(items: readonly TrayItem[], prefix: string, rowWidth: number): number {
  const longest = items.reduce((widest, item) => Math.max(widest, width(item.name)), 0);
  const described = items.some((item) => item.description !== "");
  const cap = described ? nameColumnCap : Math.max(0, rowWidth - markerCells);
  return Math.min(cap, longest + width(prefix));
}

function fittedName(item: TrayItem, cells: number): string {
  return item.jump === true ? clipStart(item.name, cells) : clip(item.name, cells);
}

function trayRow(
  item: TrayItem,
  marker: string,
  column: number,
  rowWidth: number,
  theme: Palette,
  prefix: string,
): TrayChild {
  const selected = marker !== " ";
  const shortcut = clip(item.shortcut === undefined ? " " : ` ${item.shortcut} `, rowWidth);
  const nameRoom = Math.max(0, rowWidth - width(shortcut));
  const named = `${prefix}${fittedName(item, Math.max(1, column - width(prefix)))}`;
  const name = clip(padEnd(` ${marker} ${named}`, column + markerCells), nameRoom);
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
