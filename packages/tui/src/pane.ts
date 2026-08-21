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
  borderColor?: string;
  instruments?: "calm" | "cockpit";
}

export interface FileOpenOptions {
  atEnd?: true;
}

export interface PaneIntents {
  openFile(path: string, options?: FileOpenOptions): void;
  openSession(sessionId: string, draft?: string): void;
  focusPane(id: string): void;
}

export type PaneDescriptor =
  | { kind: "conversation"; sessionId?: string }
  | { kind: "file"; path: string }
  | { kind: "browser"; root: string }
  | { kind: "session-tree"; sessionId?: string }
  | { kind: "memory" }
  | { kind: "mcp" };

export interface Pane {
  readonly id: string;
  title(): string;
  view(context: PaneContext): PaneView;
  describe?(): PaneDescriptor;
  handleKey?(chord: Chord, sequence: string | undefined): boolean;
  handlePaste?(text: string): boolean;
  handleMouse?(local: { x: number; y: number }, event: PointerEvent): boolean;
  settled?(): Promise<void>;
  dispose?(): void;
}
