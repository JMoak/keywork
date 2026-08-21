import { fitTitle } from "@keywork/engine";
import type { GlyphSupport } from "./capability.ts";
import { slugWords } from "./slug.ts";

export type HeadlineFace = "half-block" | "block" | "caps";

export interface HeadlineFrame {
  readonly width: number;
  readonly rows: number;
  readonly glyphs: GlyphSupport;
  readonly siblings?: readonly string[] | undefined;
}

export interface Headline {
  readonly face: HeadlineFace;
  readonly words: string;
  readonly lines: readonly string[];
}

export function headline(slug: string, frame: HeadlineFrame): Headline {
  const local = withoutArc(slug);
  const words = wordsOf(local);
  const blockFace = frame.glyphs.glyphTier >= 2 ? halfBlockFace : fullBlockFace;
  const setsEveryWord = words.every(
    (word) => blockFace.supports(word) && blockFace.measure(word) <= frame.width,
  );
  const faces = frame.glyphs.glyphTier >= 1 && setsEveryWord ? [blockFace, capsFace] : [capsFace];
  for (const face of faces) {
    const fitted = fitRows(local, frame, face);
    if (fitted !== undefined) return fitted;
  }
  return { face: "caps", words: "", lines: [] };
}

interface Face {
  readonly name: HeadlineFace;
  readonly rowsPerLine: number;
  readonly wordGap: number;
  supports(word: string): boolean;
  measure(word: string): number;
  rasterize(words: readonly string[]): string[];
}

const glyphGap = 1;
const bitmapRows = 5;

function fitRows(slug: string, frame: HeadlineFrame, face: Face): Headline | undefined {
  if (frame.width < 1 || frame.rows < face.rowsPerLine) return undefined;
  for (let budget = slug.length; budget >= 1; budget -= 1) {
    const words = wordsOf(fitTitle(slug, budget, frame.siblings ?? []));
    if (words.length === 0) continue;
    const lines = packLines(words, frame.width, face);
    if (lines === undefined) continue;
    const gaps = face.rowsPerLine > 1 ? lines.length - 1 : 0;
    if (lines.length * face.rowsPerLine + gaps > frame.rows) continue;
    return {
      face: face.name,
      words: words.join(" "),
      lines: lines.flatMap((line, index) =>
        index === 0 || gaps === 0 ? face.rasterize(line) : ["", ...face.rasterize(line)],
      ),
    };
  }
  return undefined;
}

function withoutArc(slug: string): string {
  const local = slug.slice(slug.indexOf(":") + 1);
  return local === "" ? slug : local;
}

function wordsOf(slug: string): string[] {
  return slugWords(slug)
    .split(" ")
    .filter((word) => word !== "");
}

function packLines(words: readonly string[], width: number, face: Face): string[][] | undefined {
  const lines: string[][] = [];
  let line: string[] = [];
  let used = 0;
  for (const word of words) {
    const cells = face.measure(word);
    if (cells > width) return undefined;
    const joined = used === 0 ? cells : used + face.wordGap + cells;
    if (joined <= width) {
      line.push(word);
      used = joined;
      continue;
    }
    lines.push(line);
    line = [word];
    used = cells;
  }
  lines.push(line);
  return lines;
}

const capsFace: Face = {
  name: "caps",
  rowsPerLine: 1,
  wordGap: 1,
  supports: () => true,
  measure: (word) => Array.from(word).length,
  rasterize: (words) => [words.map((word) => word.toUpperCase()).join(" ")],
};

const fullBlockFace: Face = bitmapFace("block", bitmapRows, (rows) =>
  rows.map((row) => row.replace(/#/g, "█").replace(/\./g, " ")),
);

const halfBlockFace: Face = bitmapFace("half-block", Math.ceil(bitmapRows / 2), (rows) => {
  const lines: string[] = [];
  for (let top = 0; top < rows.length; top += 2) {
    const upper = rows[top] ?? "";
    const lower = rows[top + 1] ?? "";
    lines.push(
      Array.from(upper)
        .map((cell, column) => halfBlock(cell === "#", lower[column] === "#"))
        .join(""),
    );
  }
  return lines;
});

function halfBlock(upper: boolean, lower: boolean): string {
  if (upper && lower) return "█";
  if (upper) return "▀";
  if (lower) return "▄";
  return " ";
}

function bitmapFace(
  name: HeadlineFace,
  rowsPerLine: number,
  render: (rows: readonly string[]) => string[],
): Face {
  return {
    name,
    rowsPerLine,
    wordGap: 3,
    supports: (word) => Array.from(word.toUpperCase()).every((glyph) => glyph in bitmaps),
    measure: (word) => {
      const glyphs = Array.from(word.toUpperCase());
      const inked = glyphs.reduce((total, glyph) => total + bitmapWidth(glyph), 0);
      return inked + glyphGap * (glyphs.length - 1);
    },
    rasterize: (words) => {
      const rows = Array.from({ length: bitmapRows }, (_, row) =>
        words.map((word) => wordRow(word, row)).join(" ".repeat(3)),
      );
      return render(rows).map((line) => line.trimEnd());
    },
  };
}

function wordRow(word: string, row: number): string {
  return Array.from(word.toUpperCase())
    .map((glyph) => bitmaps[glyph]?.[row] ?? "")
    .join(" ".repeat(glyphGap));
}

function bitmapWidth(glyph: string): number {
  return bitmaps[glyph]?.[0]?.length ?? 0;
}

const bitmaps: Readonly<Record<string, readonly string[]>> = {
  A: [".#.", "#.#", "###", "#.#", "#.#"],
  B: ["##.", "#.#", "##.", "#.#", "##."],
  C: [".##", "#..", "#..", "#..", ".##"],
  D: ["##.", "#.#", "#.#", "#.#", "##."],
  E: ["###", "#..", "##.", "#..", "###"],
  F: ["###", "#..", "##.", "#..", "#.."],
  G: [".##", "#..", "#.#", "#.#", ".##"],
  H: ["#.#", "#.#", "###", "#.#", "#.#"],
  I: ["###", ".#.", ".#.", ".#.", "###"],
  J: ["..#", "..#", "..#", "#.#", ".#."],
  K: ["#.#", "#.#", "##.", "#.#", "#.#"],
  L: ["#..", "#..", "#..", "#..", "###"],
  M: ["#.#", "###", "#.#", "#.#", "#.#"],
  N: ["##.", "#.#", "#.#", "#.#", "#.#"],
  O: [".#.", "#.#", "#.#", "#.#", ".#."],
  P: ["##.", "#.#", "##.", "#..", "#.."],
  Q: [".#.", "#.#", "#.#", ".#.", "..#"],
  R: ["##.", "#.#", "##.", "#.#", "#.#"],
  S: [".##", "#..", ".#.", "..#", "##."],
  T: ["###", ".#.", ".#.", ".#.", ".#."],
  U: ["#.#", "#.#", "#.#", "#.#", "###"],
  V: ["#.#", "#.#", "#.#", "#.#", ".#."],
  W: ["#.#", "#.#", "#.#", "###", "#.#"],
  X: ["#.#", "#.#", ".#.", "#.#", "#.#"],
  Y: ["#.#", "#.#", ".#.", ".#.", ".#."],
  Z: ["###", "..#", ".#.", "#..", "###"],
  "0": ["###", "#.#", "#.#", "#.#", "###"],
  "1": [".#.", "##.", ".#.", ".#.", "###"],
  "2": ["##.", "..#", ".#.", "#..", "###"],
  "3": ["###", "..#", ".##", "..#", "###"],
  "4": ["#.#", "#.#", "###", "..#", "..#"],
  "5": ["###", "#..", "##.", "..#", "##."],
  "6": [".##", "#..", "###", "#.#", "###"],
  "7": ["###", "..#", ".#.", ".#.", ".#."],
  "8": ["###", "#.#", "###", "#.#", "###"],
  "9": ["###", "#.#", "###", "..#", "##."],
};
