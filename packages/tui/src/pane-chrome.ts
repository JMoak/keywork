import { Box, Text } from "@opentui/core";
import type { PaneContext, PaneView } from "./pane.ts";
import type { Theme } from "./theme.ts";

export type PaneChild = Parameters<typeof Box>[1];

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
  const { theme, focused, width, height } = context;
  return Box(
    {
      width,
      height,
      border: true,
      borderStyle: "rounded",
      borderColor: focused ? theme.borderFocus : theme.border,
      title,
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

export function paneFailureLine(failure: string, theme: Theme, width: number): PaneChild {
  return Text({ content: failure.slice(0, width), fg: theme.error });
}
