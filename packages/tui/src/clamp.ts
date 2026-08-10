export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampIndex(index: number, count: number): number {
  return Math.max(0, Math.min(index, count - 1));
}

export function clampScroll(scrollTop: number, count: number, rows: number): number {
  return Math.max(0, Math.min(scrollTop, Math.max(0, count - rows)));
}
