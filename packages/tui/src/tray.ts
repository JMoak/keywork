import { Box, Text } from "@opentui/core";
import type { Theme } from "./theme.ts";

export interface TrayItem {
  name: string;
  description: string;
  shortcut?: string;
}

export interface TrayStyle {
  namePrefix?: string;
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
  const column = nameColumnWidth(items, prefix);
  return items.map((item, index) =>
    trayRow(item, index === selected, column, width, theme, prefix),
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

export function clipLine(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, Math.max(0, width));
  return `${text.slice(0, width - 1)}…`;
}

const nameColumnCap = 24;

function nameColumnWidth(items: readonly TrayItem[], prefix: string): number {
  const longest = items.reduce((width, item) => Math.max(width, item.name.length), 0);
  return Math.min(nameColumnCap, longest + prefix.length);
}

function trayRow(
  item: TrayItem,
  selected: boolean,
  column: number,
  width: number,
  theme: Theme,
  prefix: string,
): TrayChild {
  const marker = selected ? "▸" : " ";
  const name = clipLine(` ${marker} ${prefix}${item.name}`.padEnd(column + 5), width);
  const shortcut = item.shortcut === undefined ? " " : `${item.shortcut} `;
  const room = Math.max(0, width - name.length - shortcut.length);
  return Box(
    { flexDirection: "row", height: 1, overflow: "hidden" },
    Text({ content: name, fg: selected ? theme.accent : theme.text }),
    Text({
      content: clipLine(item.description, room).padEnd(room),
      fg: selected ? theme.text : theme.textDim,
    }),
    Text({ content: shortcut, fg: theme.textDim }),
  );
}
