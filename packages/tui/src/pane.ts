import type { Box } from "@opentui/core";
import type { Chord } from "./keys.ts";
import type { Theme } from "./theme.ts";

export type PaneView = ReturnType<typeof Box>;

export interface PaneContext {
  theme: Theme;
  focused: boolean;
  width: number;
  height: number;
}

export interface Pane {
  readonly id: string;
  title(): string;
  view(context: PaneContext): PaneView;
  handleKey?(chord: Chord, sequence: string | undefined): boolean;
  dispose?(): void;
}
