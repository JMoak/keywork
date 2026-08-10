import type { Box } from "@opentui/core";
import type { Chord } from "./keys.ts";
import type { PointerEvent } from "./pointer.ts";
import type { Theme } from "./theme.ts";

export type PaneView = ReturnType<typeof Box>;

export interface PaneContext {
  theme: Theme;
  focused: boolean;
  width: number;
  height: number;
}

export interface PaneIntents {
  openFile(path: string): void;
  focusPane(id: string): void;
}

export interface Pane {
  readonly id: string;
  title(): string;
  view(context: PaneContext): PaneView;
  handleKey?(chord: Chord, sequence: string | undefined): boolean;
  handleMouse?(local: { x: number; y: number }, event: PointerEvent): boolean;
  dispose?(): void;
}
