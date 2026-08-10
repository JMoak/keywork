export type PointerAction = "down" | "up" | "move" | "drag" | "drag-end" | "scroll";
export type ScrollDirection = "up" | "down";

export interface PointerScroll {
  direction: ScrollDirection;
  delta: number;
}

export interface PointerEvent {
  type: PointerAction;
  x: number;
  y: number;
  button?: number;
  scroll?: PointerScroll;
}

export interface RawPointerEvent {
  type: string;
  x: number;
  y: number;
  button?: number;
  scroll?: { direction: string; delta: number };
}

export function pointerEventOf(raw: RawPointerEvent): PointerEvent | undefined {
  if (raw.type === "scroll") {
    const direction = raw.scroll?.direction;
    if (direction !== "up" && direction !== "down") return undefined;
    return {
      type: "scroll",
      x: raw.x,
      y: raw.y,
      scroll: { direction, delta: sanitizedDelta(raw.scroll?.delta) },
    };
  }
  if (!isPointerAction(raw.type)) return undefined;
  return {
    type: raw.type,
    x: raw.x,
    y: raw.y,
    ...(raw.button !== undefined && { button: raw.button }),
  };
}

const pointerActions: ReadonlySet<string> = new Set([
  "down",
  "up",
  "move",
  "drag",
  "drag-end",
] satisfies PointerAction[]);

function isPointerAction(type: string): type is PointerAction {
  return pointerActions.has(type);
}

function sanitizedDelta(delta: number | undefined): number {
  return delta !== undefined && Number.isFinite(delta) && delta > 0 ? delta : 1;
}
