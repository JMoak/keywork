import type { Rect } from "./geometry.ts";
import type { ChromeWeight } from "./pane.ts";
import { isSeamed } from "./pane-chrome.ts";
import { innerRect } from "./view/seams.ts";

export interface DrawnLayout {
  readonly chrome: ChromeWeight;
  readonly gap: number;
}

export function drawnRect(rect: Rect, field: Rect, layout: DrawnLayout): Rect {
  const seamed = isSeamed(layout.chrome) ? innerRect(rect, field) : rect;
  return gapped(seamed, rect, field, layout.gap);
}

function gapped(drawn: Rect, rect: Rect, field: Rect, gap: number): Rect {
  if (gap <= 0) return drawn;
  const left = rect.x > field.x ? gap : 0;
  const top = rect.y > field.y ? gap : 0;
  const right = rightEdge(rect) < rightEdge(field) ? gap : 0;
  const bottom = bottomEdge(rect) < bottomEdge(field) ? gap : 0;
  return {
    x: drawn.x + left,
    y: drawn.y + top,
    width: Math.max(0, drawn.width - left - right),
    height: Math.max(0, drawn.height - top - bottom),
  };
}

function rightEdge(rect: Rect): number {
  return rect.x + rect.width - 1;
}

function bottomEdge(rect: Rect): number {
  return rect.y + rect.height - 1;
}
