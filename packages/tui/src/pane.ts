import type { Flavor } from "@keywork/shared";
import type { Box } from "@opentui/core";
import type { GlyphSupport } from "./capability.ts";
import type { Chord } from "./keys.ts";
import type { PointerEvent } from "./pointer.ts";
import type { SessionGroupBy } from "./sessions-overview-model.ts";
import type { Theme } from "./theme.ts";

export type PaneView = ReturnType<typeof Box>;

export type ChromeWeight = Flavor["chromeWeight"];

export type LifecycleState = "idle" | "working" | "needs-you" | "finished-unseen" | "failed";

export interface PaneContext {
  theme: Theme;
  focused: boolean;
  width: number;
  height: number;
  chrome?: ChromeWeight;
  costs?: boolean;
  hue?: string;
  glyphs?: GlyphSupport;
  instruments?: Flavor["instruments"];
  pinMark?: string;
}

export interface FileOpenOptions {
  atEnd?: true;
}

export interface PaneIntents {
  openFile(path: string, options?: FileOpenOptions): void;
  openSession(sessionId: string, draft?: string): void;
  focusPane(id: string): void;
  notice?(text: string): void;
  holdPane?(id: string): boolean;
  showPane?(id: string, near?: readonly string[]): boolean;
  paneHeld?(id: string): boolean;
}

export type PaneDescriptor =
  | { kind: "conversation"; sessionId?: string }
  | { kind: "file"; path: string }
  | { kind: "browser"; root: string }
  | { kind: "session-tree"; sessionId?: string; groupBy?: SessionGroupBy }
  | { kind: "arcs"; arc?: string }
  | { kind: "arc"; arc: string }
  | { kind: "memory"; lens?: MemoryLens; note?: string; query?: string }
  | { kind: "mcp" }
  | { kind: "workspaces" };

export type MemoryLens = "garden" | "note" | "ledger";

export interface Pane {
  readonly id: string;
  title(): string;
  view(context: PaneContext): PaneView;
  lifecycle?(): LifecycleState;
  describe?(): PaneDescriptor;
  handleKey?(chord: Chord, sequence: string | undefined): boolean;
  handlePaste?(text: string): boolean;
  handleMouse?(local: { x: number; y: number }, event: PointerEvent): boolean;
  settled?(): Promise<void>;
  revealed?(): void;
  dispose?(): void;
}
