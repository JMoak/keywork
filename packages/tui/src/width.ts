export interface Segment {
  readonly text: string;
  readonly width: number;
}

export const ellipsis = "…";

export function width(text: string): number {
  return segments(text).reduce((total, segment) => total + segment.width, 0);
}

export function clip(text: string, cells: number): string {
  if (width(text) <= cells) return text;
  if (cells <= 0) return "";
  if (cells === 1) return ellipsis;
  return `${take(text, cells - 1)}${ellipsis}`;
}

export function take(text: string, cells: number): string {
  let used = 0;
  let taken = "";
  for (const segment of segments(text)) {
    if (used + segment.width > cells) break;
    taken += segment.text;
    used += segment.width;
  }
  return taken;
}

export function padEnd(text: string, cells: number, fill = " "): string {
  const gap = cells - width(text);
  return gap > 0 ? text + fill.repeat(gap) : text;
}

export function wrap(text: string, cells: number): string[] {
  if (cells < 1) return [text];
  if (text === "") return [""];
  const pieces: string[] = [];
  let piece = "";
  let used = 0;
  for (const segment of segments(text)) {
    if (used > 0 && used + segment.width > cells) {
      pieces.push(piece);
      piece = "";
      used = 0;
    }
    piece += segment.text;
    used += segment.width;
  }
  pieces.push(piece);
  return pieces;
}

export function clipSpans<Span extends { text: string }>(
  spans: readonly Span[],
  cells: number,
  ellipsis?: Span,
): Span[] {
  const total = spans.reduce((sum, span) => sum + width(span.text), 0);
  if (total <= cells) return spans.map((span) => ({ ...span }));
  const marker = ellipsis === undefined || cells < width(ellipsis.text) ? undefined : ellipsis;
  const budget = cells - (marker === undefined ? 0 : width(marker.text));
  const clipped: Span[] = [];
  let used = 0;
  for (const span of spans) {
    const room = budget - used;
    if (room <= 0) break;
    const spanWidth = width(span.text);
    if (spanWidth <= room) {
      clipped.push({ ...span });
      used += spanWidth;
      continue;
    }
    const head = take(span.text, room);
    if (head !== "") clipped.push({ ...span, text: head });
    break;
  }
  if (marker !== undefined) clipped.push(marker);
  return clipped;
}

export function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let open: OpenSegment | undefined;
  for (const glyph of text) {
    const code = glyph.codePointAt(0) ?? 0;
    if (open !== undefined && joins(open, code)) {
      open.text += glyph;
      open.width = Math.max(open.width, cellsOf(code), code === emojiPresentation ? 2 : 0);
      open.joinerPending = code === zeroWidthJoiner;
      open.flagHalf = false;
      continue;
    }
    if (open !== undefined) out.push({ text: open.text, width: open.width });
    open = {
      text: glyph,
      width: cellsOf(code),
      joinerPending: false,
      flagHalf: isRegionalIndicator(code),
    };
  }
  if (open !== undefined) out.push({ text: open.text, width: open.width });
  return out;
}

interface OpenSegment {
  text: string;
  width: number;
  joinerPending: boolean;
  flagHalf: boolean;
}

const zeroWidthJoiner = 0x200d;
const emojiPresentation = 0xfe0f;

function joins(open: OpenSegment, code: number): boolean {
  return open.joinerPending || isZeroWidth(code) || (open.flagHalf && isRegionalIndicator(code));
}

function cellsOf(code: number): number {
  if (isZeroWidth(code)) return 0;
  return inRanges(code, wideRanges) ? 2 : 1;
}

function isZeroWidth(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code < 0xa0) || inRanges(code, zeroWidthRanges);
}

function isRegionalIndicator(code: number): boolean {
  return code >= 0x1f1e6 && code <= 0x1f1ff;
}

function inRanges(code: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([low, high]) => code >= low && code <= high);
}

const zeroWidthRanges: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad],
  [0x0300, 0x036f],
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x05bf, 0x05c7],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x06df, 0x06e4],
  [0x06e7, 0x06e8],
  [0x06ea, 0x06ed],
  [0x0900, 0x0902],
  [0x093c, 0x093c],
  [0x0941, 0x0948],
  [0x094d, 0x094d],
  [0x0951, 0x0957],
  [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a],
  [0x0e47, 0x0e4e],
  [0x1160, 0x11ff],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x20d0, 0x20ff],
  [0xd7b0, 0xd7ff],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff],
  [0x1f3fb, 0x1f3ff],
  [0xe0020, 0xe007f],
  [0xe0100, 0xe01ef],
];

const wideRanges: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18aff],
  [0x1b000, 0x1b2ff],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f1e6, 0x1f1ff],
  [0x1f200, 0x1f251],
  [0x1f260, 0x1f265],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];
