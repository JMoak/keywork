import { Box, Text } from "@opentui/core";
import type { PaneContext, PaneView } from "./pane.ts";
import type { Theme } from "./theme.ts";

export type PaneChild = Parameters<typeof Box>[1];

export function paneChrome(
  context: PaneContext,
  title: string,
  ...children: PaneChild[]
): PaneView {
  const { theme, focused } = context;
  return Box(
    {
      flexGrow: 1,
      flexBasis: 0,
      border: true,
      borderStyle: "rounded",
      borderColor: focused ? theme.borderFocus : theme.border,
      title,
      titleAlignment: "left",
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
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
