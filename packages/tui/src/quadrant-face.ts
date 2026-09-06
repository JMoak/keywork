export const quadrantRowsPerLine = 3;

export function quadrantSupports(word: string): boolean {
  return Array.from(word.toUpperCase()).every((glyph) => glyph in glyphs);
}

export function quadrantMeasure(word: string): number {
  const shapes = shapesOf(word);
  if (shapes.length === 0) return 0;
  const subpixels = shapes.reduce((total, shape) => total + shape.width, 0) + shapes.length - 1;
  return Math.ceil(subpixels / 2);
}

export function quadrantRasterize(words: readonly string[]): string[] {
  const rendered = words.map(renderWord);
  return Array.from({ length: quadrantRowsPerLine }, (_, row) =>
    rendered
      .map((word) => word[row] ?? "")
      .join(wordGap)
      .trimEnd(),
  );
}

const wordGap = "   ";
const subpixelRowsTall = 6;

interface GlyphShape {
  readonly width: number;
  readonly rows: readonly string[];
}

function shapesOf(word: string): GlyphShape[] {
  return Array.from(word.toUpperCase())
    .map((glyph) => glyphs[glyph])
    .filter((rows): rows is readonly string[] => rows !== undefined)
    .map((rows) => ({ width: rows[0]?.length ?? 0, rows }));
}

function renderWord(word: string): string[] {
  const rows = subpixelRows(word);
  const cells = Math.ceil((rows[0]?.length ?? 0) / 2);
  return Array.from({ length: quadrantRowsPerLine }, (_, line) => {
    const upper = rows[line * 2] ?? "";
    const lower = rows[line * 2 + 1] ?? "";
    return Array.from({ length: cells }, (_, cell) => quadrantChar(upper, lower, cell * 2)).join(
      "",
    );
  });
}

function subpixelRows(word: string): string[] {
  const shapes = shapesOf(word);
  return Array.from({ length: subpixelRowsTall }, (_, row) =>
    shapes.map((shape) => shape.rows[row] ?? "").join("."),
  );
}

function quadrantChar(upper: string, lower: string, at: number): string {
  const bit = (row: string, column: number, value: number) => (row[column] === "#" ? value : 0);
  return quadrants[
    bit(upper, at, 1) + bit(upper, at + 1, 2) + bit(lower, at, 4) + bit(lower, at + 1, 8)
  ] as string;
}

const quadrants = [" ", "▘", "▝", "▀", "▖", "▌", "▞", "▛", "▗", "▚", "▐", "▜", "▄", "▙", "▟", "█"];

const glyphs: Readonly<Record<string, readonly string[]>> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#"],
  B: ["####.", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".####", "#....", "#....", "#....", "#....", ".####"],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "###..", "#....", "#....", "#####"],
  F: ["#####", "#....", "###..", "#....", "#....", "#...."],
  G: [".####", "#....", "#..##", "#...#", "#...#", ".###."],
  H: ["#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: ["###", ".#.", ".#.", ".#.", ".#.", "###"],
  J: ["....#", "....#", "....#", "....#", "#...#", ".###."],
  K: ["#...#", "#..#.", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", ".#.#.", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
  X: ["#...#", ".#.#.", "..#..", "..#..", ".#.#.", "#...#"],
  Y: ["#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "...#.", "..#..", ".#...", "#....", "#####"],
  "0": [".###.", "#..##", "#.#.#", "#.#.#", "##..#", ".###."],
  "1": [".#.", "##.", ".#.", ".#.", ".#.", "###"],
  "2": [".###.", "#...#", "...#.", "..#..", ".#...", "#####"],
  "3": ["####.", "....#", ".###.", "....#", "....#", "####."],
  "4": ["...##", "..#.#", ".#..#", "#####", "....#", "....#"],
  "5": ["#####", "#....", "####.", "....#", "....#", "####."],
  "6": [".###.", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", "..#..", "..#.."],
  "8": [".###.", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", ".####", "....#", "....#", ".###."],
};
