import { fitTitle } from "@keywork/engine";
import type { GlyphSupport } from "./capability.ts";
import type { PageTier } from "./page.ts";
import { slugWords } from "./slug.ts";
import { strokeMeasure, strokeRasterize, strokeRows, strokeSupports } from "./stroke-face.ts";
import { width } from "./width.ts";

export type HeadlineFace =
  | "stroke"
  | "half-block"
  | "half-block-condensed"
  | "block"
  | "block-condensed"
  | "caps";

export interface MastheadMoment {
  readonly tier: PageTier;
  readonly focused: boolean;
  readonly asking: boolean;
  readonly backtracking: boolean;
  readonly disclosing: boolean;
  readonly failedUnseen: boolean;
  readonly enabled: boolean;
}

export function wearsMasthead(moment: MastheadMoment): boolean {
  return (
    moment.enabled &&
    moment.tier === "masthead" &&
    !moment.focused &&
    !moment.asking &&
    !moment.backtracking &&
    !moment.disclosing &&
    !moment.failedUnseen
  );
}

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
  return (
    mostWordsSet(local, frame, blockFacesFor(wordsOf(local), frame)) ??
    mostWordsSet(local, frame, [capsFace]) ?? { face: "caps", words: "", lines: [] }
  );
}

function mostWordsSet(
  slug: string,
  frame: HeadlineFrame,
  largestFirst: readonly Face[],
): Headline | undefined {
  for (let budget = slug.length; budget >= 1; budget -= 1) {
    const fitted = wordsOf(fitTitle(slug, budget, frame.siblings ?? []));
    if (fitted.length === 0) continue;
    for (const face of largestFirst) {
      const set = setWords(fitted, frame, face);
      if (set !== undefined) return set;
    }
  }
  return undefined;
}

function blockFacesFor(words: readonly string[], frame: HeadlineFrame): Face[] {
  const { glyphTier } = frame.glyphs;
  if (glyphTier < 1) return [];
  const bitmapFaces =
    glyphTier >= 2 ? [halfBlockFace, condensedHalfBlockFace] : [fullBlockFace, condensedBlockFace];
  const strokeFaces = glyphTier >= 2 ? strokeScales.map(strokeFace) : [];
  return [...strokeFaces, ...bitmapFaces].filter((face) =>
    words.every((word) => face.supports(word) && face.measure(word) <= frame.width),
  );
}

const strokeScales = [3, 2, 1] as const;

function strokeFace(scale: number): Face {
  return {
    name: "stroke",
    rowsPerLine: strokeRows(scale),
    wordGap: 3 * scale,
    supports: strokeSupports,
    measure: (word) => strokeMeasure(word, scale),
    rasterize: (words) => strokeRasterize(words, scale),
  };
}

interface Face {
  readonly name: HeadlineFace;
  readonly rowsPerLine: number;
  readonly wordGap: number;
  supports(word: string): boolean;
  measure(word: string): number;
  rasterize(words: readonly string[]): string[];
}

const bitmapRows = 5;

function setWords(
  words: readonly string[],
  frame: HeadlineFrame,
  face: Face,
): Headline | undefined {
  if (frame.width < 1 || frame.rows < face.rowsPerLine) return undefined;
  const lines = packLines(words, frame.width, face);
  if (lines === undefined) return undefined;
  const gaps = face.rowsPerLine > 1 ? lines.length - 1 : 0;
  if (lines.length * face.rowsPerLine + gaps > frame.rows) return undefined;
  return {
    face: face.name,
    words: words.join(" "),
    lines: lines.flatMap((line, index) =>
      index === 0 || gaps === 0 ? face.rasterize(line) : ["", ...face.rasterize(line)],
    ),
  };
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
  measure: width,
  rasterize: (words) => [words.map((word) => word.toUpperCase()).join(" ")],
};

function renderFullBlocks(rows: readonly string[]): string[] {
  return rows.map((row) => row.replace(/#/g, "█").replace(/\./g, " "));
}

function renderHalfBlocks(rows: readonly string[]): string[] {
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
}

const halfBlockRows = Math.ceil(bitmapRows / 2);

const fullBlockFace: Face = bitmapFace("block", bitmapRows, 1, renderFullBlocks);
const condensedBlockFace: Face = bitmapFace("block-condensed", bitmapRows, 0, renderFullBlocks);
const halfBlockFace: Face = bitmapFace("half-block", halfBlockRows, 1, renderHalfBlocks);
const condensedHalfBlockFace: Face = bitmapFace(
  "half-block-condensed",
  halfBlockRows,
  0,
  renderHalfBlocks,
);

function halfBlock(upper: boolean, lower: boolean): string {
  if (upper && lower) return "█";
  if (upper) return "▀";
  if (lower) return "▄";
  return " ";
}

function bitmapFace(
  name: HeadlineFace,
  rowsPerLine: number,
  glyphGap: number,
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
        words.map((word) => wordRow(word, row, glyphGap)).join(" ".repeat(3)),
      );
      return render(rows).map((line) => line.trimEnd());
    },
  };
}

function wordRow(word: string, row: number, glyphGap: number): string {
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
