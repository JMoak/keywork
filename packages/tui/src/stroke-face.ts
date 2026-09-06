export interface StrokeGlyph {
  readonly units: number;
  readonly strokes: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
}

export const strokeUnitsTall = 7;

export function strokeRows(scale: number): number {
  return Math.ceil((strokeUnitsTall * scale) / 2);
}

export function strokeSupports(word: string): boolean {
  return Array.from(word.toUpperCase()).every((glyph) => glyph in glyphs);
}

export function strokeMeasure(word: string, scale: number): number {
  const shapes = Array.from(word.toUpperCase()).map(glyphOf);
  const inked = shapes.reduce((total, shape) => total + shape.units * scale, 0);
  return inked + glyphGapUnits * scale * Math.max(0, shapes.length - 1);
}

export function strokeRasterize(words: readonly string[], scale: number): string[] {
  const wordGap = " ".repeat(wordGapUnits * scale);
  const glyphGap = " ".repeat(glyphGapUnits * scale);
  const rows = strokeRows(scale);
  const lines = Array.from({ length: rows }, () => "");
  const wordsInk = words.map((word) =>
    Array.from(word.toUpperCase())
      .map((glyph) => rasterizeGlyph(glyphOf(glyph), scale))
      .reduce<string[]>(
        (line, ink) => line.map((row, index) => `${row}${row === "" ? "" : glyphGap}${ink[index]}`),
        Array.from({ length: rows }, () => ""),
      ),
  );
  return lines.map((_, row) =>
    wordsInk
      .map((ink) => ink[row] ?? "")
      .join(wordGap)
      .trimEnd(),
  );
}

const glyphGapUnits = 1;
const wordGapUnits = 3;

function glyphOf(glyph: string): StrokeGlyph {
  return glyphs[glyph] ?? glyphs["-"] ?? { units: 1, strokes: [] };
}

function rasterizeGlyph(glyph: StrokeGlyph, scale: number): string[] {
  const columns = glyph.units * scale;
  const pixelRows = strokeUnitsTall * scale;
  const ink = Array.from({ length: pixelRows }, () => Array<boolean>(columns).fill(false));
  for (const stroke of glyph.strokes) stampPolyline(ink, stroke, scale);
  const lines: string[] = [];
  for (let top = 0; top < pixelRows; top += 2) {
    const upper = ink[top] ?? [];
    const lower = ink[top + 1] ?? [];
    lines.push(
      Array.from({ length: columns }, (_, column) =>
        halfBlock(upper[column] === true, lower[column] === true),
      ).join(""),
    );
  }
  return lines;
}

function stampPolyline(
  ink: boolean[][],
  points: ReadonlyArray<readonly [number, number]>,
  scale: number,
): void {
  for (let index = 0; index + 1 < points.length; index += 1) {
    const [x0, y0] = points[index] as readonly [number, number];
    const [x1, y1] = points[index + 1] as readonly [number, number];
    const steps = Math.max(
      1,
      Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * scale * 2),
    );
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      stampBrush(ink, (x0 + (x1 - x0) * t) * scale, (y0 + (y1 - y0) * t) * scale, scale);
    }
  }
  if (points.length === 1) {
    const [x, y] = points[0] as readonly [number, number];
    stampBrush(ink, x * scale, y * scale, scale);
  }
}

function stampBrush(ink: boolean[][], left: number, top: number, scale: number): void {
  const x0 = Math.round(left);
  const y0 = Math.round(top);
  for (let y = y0; y < y0 + scale; y += 1) {
    const row = ink[y];
    if (row === undefined) continue;
    for (let x = x0; x < x0 + scale; x += 1) if (x >= 0 && x < row.length) row[x] = true;
  }
}

function halfBlock(upper: boolean, lower: boolean): string {
  if (upper && lower) return "█";
  if (upper) return "▀";
  if (lower) return "▄";
  return " ";
}

const glyphs: Readonly<Record<string, StrokeGlyph>> = {
  A: {
    units: 5,
    strokes: [
      [
        [0, 6],
        [0, 2],
        [2, 0],
        [4, 2],
        [4, 6],
      ],
      [
        [0, 4],
        [4, 4],
      ],
    ],
  },
  B: {
    units: 4,
    strokes: [
      [
        [0, 0],
        [0, 6],
      ],
      [
        [0, 0],
        [2, 0],
        [3, 1],
        [3, 2],
        [2, 3],
        [0, 3],
      ],
      [
        [0, 3],
        [2, 3],
        [3, 4],
        [3, 5],
        [2, 6],
        [0, 6],
      ],
    ],
  },
  C: {
    units: 4,
    strokes: [
      [
        [3, 1],
        [2, 0],
        [1, 0],
        [0, 1],
        [0, 5],
        [1, 6],
        [2, 6],
        [3, 5],
      ],
    ],
  },
  D: {
    units: 4,
    strokes: [
      [
        [0, 0],
        [0, 6],
      ],
      [
        [0, 0],
        [2, 0],
        [3, 1],
        [3, 5],
        [2, 6],
        [0, 6],
      ],
    ],
  },
  E: {
    units: 4,
    strokes: [
      [
        [3, 0],
        [0, 0],
        [0, 6],
        [3, 6],
      ],
      [
        [0, 3],
        [2, 3],
      ],
    ],
  },
  F: {
    units: 4,
    strokes: [
      [
        [3, 0],
        [0, 0],
        [0, 6],
      ],
      [
        [0, 3],
        [2, 3],
      ],
    ],
  },
  G: {
    units: 4,
    strokes: [
      [
        [3, 1],
        [2, 0],
        [1, 0],
        [0, 1],
        [0, 5],
        [1, 6],
        [2, 6],
        [3, 5],
        [3, 3],
        [2, 3],
      ],
    ],
  },
  H: {
    units: 4,
    strokes: [
      [
        [0, 0],
        [0, 6],
      ],
      [
        [3, 0],
        [3, 6],
      ],
      [
        [0, 3],
        [3, 3],
      ],
    ],
  },
  I: {
    units: 1,
    strokes: [
      [
        [0, 0],
        [0, 6],
      ],
    ],
  },
  J: {
    units: 4,
    strokes: [
      [
        [3, 0],
        [3, 5],
        [2, 6],
        [1, 6],
        [0, 5],
      ],
    ],
  },
  K: {
    units: 4,
    strokes: [
      [
        [0, 0],
        [0, 6],
      ],
      [
        [3, 0],
        [0, 3],
        [3, 6],
      ],
    ],
  },
  L: {
    units: 4,
    strokes: [
      [
        [0, 0],
        [0, 6],
        [3, 6],
      ],
    ],
  },
  M: {
    units: 5,
    strokes: [
      [
        [0, 6],
        [0, 1],
        [1, 0],
        [2, 1],
        [2, 6],
      ],
      [
        [2, 1],
        [3, 0],
        [4, 1],
        [4, 6],
      ],
    ],
  },
  N: {
    units: 4,
    strokes: [
      [
        [0, 6],
        [0, 0],
        [3, 6],
        [3, 0],
      ],
    ],
  },
  O: {
    units: 4,
    strokes: [
      [
        [0, 5],
        [0, 1],
        [1, 0],
        [2, 0],
        [3, 1],
        [3, 5],
        [2, 6],
        [1, 6],
        [0, 5],
      ],
    ],
  },
  P: {
    units: 4,
    strokes: [
      [
        [0, 6],
        [0, 0],
        [2, 0],
        [3, 1],
        [3, 2],
        [2, 3],
        [0, 3],
      ],
    ],
  },
  Q: {
    units: 4,
    strokes: [
      [
        [0, 5],
        [0, 1],
        [1, 0],
        [2, 0],
        [3, 1],
        [3, 5],
        [2, 6],
        [1, 6],
        [0, 5],
      ],
      [
        [2, 4],
        [3, 6],
      ],
    ],
  },
  R: {
    units: 4,
    strokes: [
      [
        [0, 6],
        [0, 0],
        [2, 0],
        [3, 1],
        [3, 2],
        [2, 3],
        [0, 3],
      ],
      [
        [1, 3],
        [3, 6],
      ],
    ],
  },
  S: {
    units: 4,
    strokes: [
      [
        [3, 1],
        [2, 0],
        [1, 0],
        [0, 1],
        [0, 2],
        [1, 3],
        [2, 3],
        [3, 4],
        [3, 5],
        [2, 6],
        [1, 6],
        [0, 5],
      ],
    ],
  },
  T: {
    units: 5,
    strokes: [
      [
        [0, 0],
        [4, 0],
      ],
      [
        [2, 0],
        [2, 6],
      ],
    ],
  },
  U: {
    units: 4,
    strokes: [
      [
        [0, 0],
        [0, 5],
        [1, 6],
        [2, 6],
        [3, 5],
        [3, 0],
      ],
    ],
  },
  V: {
    units: 5,
    strokes: [
      [
        [0, 0],
        [0, 3],
        [2, 6],
        [4, 3],
        [4, 0],
      ],
    ],
  },
  W: {
    units: 5,
    strokes: [
      [
        [0, 0],
        [0, 5],
        [1, 6],
        [2, 5],
        [2, 0],
      ],
      [
        [2, 5],
        [3, 6],
        [4, 5],
        [4, 0],
      ],
    ],
  },
  X: {
    units: 5,
    strokes: [
      [
        [0, 0],
        [4, 6],
      ],
      [
        [4, 0],
        [0, 6],
      ],
    ],
  },
  Y: {
    units: 5,
    strokes: [
      [
        [0, 0],
        [2, 3],
        [4, 0],
      ],
      [
        [2, 3],
        [2, 6],
      ],
    ],
  },
  Z: {
    units: 4,
    strokes: [
      [
        [0, 0],
        [3, 0],
        [0, 6],
        [3, 6],
      ],
    ],
  },
  "0": {
    units: 4,
    strokes: [
      [
        [0, 5],
        [0, 1],
        [1, 0],
        [2, 0],
        [3, 1],
        [3, 5],
        [2, 6],
        [1, 6],
        [0, 5],
      ],
    ],
  },
  "1": {
    units: 3,
    strokes: [
      [
        [0, 1],
        [1, 0],
        [1, 6],
      ],
      [
        [0, 6],
        [2, 6],
      ],
    ],
  },
  "2": {
    units: 4,
    strokes: [
      [
        [0, 1],
        [1, 0],
        [2, 0],
        [3, 1],
        [3, 2],
        [0, 6],
        [3, 6],
      ],
    ],
  },
  "3": {
    units: 4,
    strokes: [
      [
        [0, 0],
        [3, 0],
        [1, 3],
        [2, 3],
        [3, 4],
        [3, 5],
        [2, 6],
        [1, 6],
        [0, 5],
      ],
    ],
  },
  "4": {
    units: 4,
    strokes: [
      [
        [3, 6],
        [3, 0],
        [0, 4],
        [3, 4],
      ],
    ],
  },
  "5": {
    units: 4,
    strokes: [
      [
        [3, 0],
        [0, 0],
        [0, 3],
        [2, 3],
        [3, 4],
        [3, 5],
        [2, 6],
        [1, 6],
        [0, 5],
      ],
    ],
  },
  "6": {
    units: 4,
    strokes: [
      [
        [3, 1],
        [2, 0],
        [1, 0],
        [0, 1],
        [0, 5],
        [1, 6],
        [2, 6],
        [3, 5],
        [3, 4],
        [2, 3],
        [0, 3],
      ],
    ],
  },
  "7": {
    units: 4,
    strokes: [
      [
        [0, 0],
        [3, 0],
        [1, 6],
      ],
    ],
  },
  "8": {
    units: 4,
    strokes: [
      [
        [1, 3],
        [0, 2],
        [0, 1],
        [1, 0],
        [2, 0],
        [3, 1],
        [3, 2],
        [2, 3],
        [1, 3],
        [0, 4],
        [0, 5],
        [1, 6],
        [2, 6],
        [3, 5],
        [3, 4],
        [2, 3],
      ],
    ],
  },
  "9": {
    units: 4,
    strokes: [
      [
        [0, 5],
        [1, 6],
        [2, 6],
        [3, 5],
        [3, 1],
        [2, 0],
        [1, 0],
        [0, 1],
        [0, 2],
        [1, 3],
        [3, 3],
      ],
    ],
  },
  "-": {
    units: 3,
    strokes: [
      [
        [0, 3],
        [2, 3],
      ],
    ],
  },
};
