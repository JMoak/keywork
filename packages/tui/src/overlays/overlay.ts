import { contains, type Rect, type Screen } from "../geometry.ts";
import type { Chord } from "../keys.ts";
import type { PointerEvent } from "../pointer.ts";

export type OverlayKind =
  | "palette"
  | "help"
  | "preset"
  | "preset-confirm"
  | "model"
  | "arc"
  | "workspace"
  | "connect";

export interface OverlayFrame extends Rect {
  firstRowY: number;
}

export abstract class RowOverlay {
  abstract readonly kind: OverlayKind;

  abstract frame(screen: Screen): OverlayFrame;

  abstract rowCount(): number;

  abstract handleKey(chord: Chord, sequence: string | undefined): void;

  handlePaste(_line: string): void {}

  handleMouse(event: PointerEvent, screen: Screen): void {
    routeRows(event, this.frame(screen), this.rowCount(), this);
  }

  hover(_row: number): void {}

  abstract click(row: number): void;

  abstract outside(): void;
}

export interface RowHits {
  hover(row: number): void;
  click(row: number): void;
  outside(): void;
}

export function routeRows(
  event: PointerEvent,
  frame: OverlayFrame,
  rowCount: number,
  hits: RowHits,
): void {
  const inside = contains(frame, event.x, event.y);
  const row = event.y - frame.firstRowY;
  const onRow = inside && row >= 0 && row < rowCount;
  if (onRow && (event.type === "move" || event.type === "drag")) hits.hover(row);
  if (event.type !== "down") return;
  if (!inside) hits.outside();
  else if (onRow) hits.click(row);
}

export function paletteFrame(screen: Screen, rowCount: number): OverlayFrame {
  const width = Math.min(64, screen.width - 4);
  const x = Math.max(2, Math.floor((screen.width - width) / 2));
  const y = 2;
  return { x, y, width, height: Math.max(1, rowCount) + 5, firstRowY: y + 3 };
}

export function helpFrame(screen: Screen, rowCount: number): OverlayFrame {
  const width = Math.min(52, screen.width - 4);
  const height = rowCount + 5;
  const y = Math.max(1, Math.floor((screen.height - height) / 2));
  return {
    x: Math.max(2, Math.floor((screen.width - width) / 2)),
    y,
    width,
    height,
    firstRowY: y + 2,
  };
}

export function pastedLine(text: string): string {
  return text.replace(/\r\n?|\n/g, " ").trim();
}

export function isEnter(chord: Chord): boolean {
  return chord.name === "return" || chord.name === "enter";
}

export function steppedIndex(index: number, chord: Chord, count: number): number | undefined {
  if (chord.name !== "up" && chord.name !== "down") return undefined;
  const step = chord.name === "down" ? 1 : -1;
  const span = Math.max(1, count);
  return (index + step + span) % span;
}
