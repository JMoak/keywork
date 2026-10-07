import { type SpanLinker, unlinked } from "./file-references.ts";
import { type Highlighter, highlighterFor, type SyntaxClass } from "./highlighter.ts";
import { defaultPageMarks, type PageMarks } from "./marks.ts";
import { segments, take, width } from "./width.ts";

export type MarkdownTone =
  | "body"
  | "code"
  | "link"
  | "linkUrl"
  | "heading"
  | "headingMark"
  | "listMarker"
  | "rule"
  | "fence"
  | "fenceRail"
  | "fenceTag"
  | "meta"
  | "ok"
  | "bad"
  | SyntaxClass;

export interface MarkdownSpan {
  text: string;
  tone: MarkdownTone;
  bold?: true;
  italic?: true;
  href?: string;
}

export interface MarkdownRow {
  spans: MarkdownSpan[];
  panel: boolean;
}

export function renderMarkdown(
  source: string,
  proseColumns: number,
  bleedColumns: number,
  marks: PageMarks = defaultPageMarks,
  link: SpanLinker = unlinked,
): MarkdownRow[] {
  const prose = Math.max(1, proseColumns);
  const bleed = Math.max(1, bleedColumns);
  const rows: MarkdownRow[] = [];
  let fence: Fence | undefined;
  for (const line of source.split("\n")) {
    const head = fenceLine.exec(line);
    if (head !== null) {
      if (fence === undefined) {
        fence = openFence(head[1] ?? "", marks, link);
        rows.push(fence.head);
      } else {
        fence = undefined;
      }
      continue;
    }
    rows.push(
      ...(fence === undefined ? blockRows(line, prose, marks, link) : fence.rows(line, bleed)),
    );
  }
  return rows;
}

export function markdownRowText(row: MarkdownRow): string {
  return row.spans.map((span) => span.text).join("");
}

export function markdownBlocks(source: string): string[] {
  const blocks: string[] = [];
  let fence: string[] | undefined;
  for (const line of source.split("\n")) {
    if (fence !== undefined) {
      fence.push(line);
      if (fenceLine.test(line)) {
        blocks.push(fence.join("\n"));
        fence = undefined;
      }
      continue;
    }
    if (fenceLine.test(line)) fence = [line];
    else blocks.push(line);
  }
  if (fence !== undefined) blocks.push(fence.join("\n"));
  return blocks;
}

const fenceLine = /^ {0,3}`{3,} *([^`\s]*).*$/;
const headingLine = /^(#{1,6}) +(.*\S) *$/;
const ruleLine = /^ {0,3}(-{3,}|\*{3,}|_{3,}) *$/;
const bulletLine = /^(\s*)[-*+] +(\S.*)$/;
const orderedLine = /^(\s*)(\d{1,9}[.)]) +(\S.*)$/;
const linkPattern = /^\[([^\]\n]+)\]\(([^()\s]+)\)/;

interface Fence {
  readonly head: MarkdownRow;
  rows(line: string, bleed: number): MarkdownRow[];
}

function openFence(language: string, marks: PageMarks, link: SpanLinker): Fence {
  const rail: MarkdownSpan = { text: `${marks.fenceRail} `, tone: "fenceRail" };
  const code = highlighterFor(language);
  return {
    head: fenceHeadRow(rail, language),
    rows: (line, bleed) => fenceRows(rail, code, line, bleed, link),
  };
}

function blockRows(line: string, prose: number, marks: PageMarks, link: SpanLinker): MarkdownRow[] {
  if (line.trim() === "") return [{ spans: [], panel: false }];
  const heading = headingLine.exec(line);
  if (heading !== null) {
    const depth = (heading[1] ?? "#").length;
    return headingRows(depth, link(inlineSpans(heading[2] ?? "", headingStyle)), prose, marks);
  }
  if (ruleLine.test(line)) return [ruleRow(prose, marks)];
  const bullet = bulletLine.exec(line);
  if (bullet !== null) {
    return listRows(bullet[1] ?? "", marks.bullet, link(bodySpans(bullet[2] ?? "")), prose);
  }
  const ordered = orderedLine.exec(line);
  if (ordered !== null) {
    return listRows(ordered[1] ?? "", ordered[2] ?? "", link(bodySpans(ordered[3] ?? "")), prose);
  }
  return proseRows(link(bodySpans(line)), prose, []);
}

const headingStyle: InlineStyle = { tone: "heading", bold: true };

function bodySpans(text: string): MarkdownSpan[] {
  return inlineSpans(text, { tone: "body" });
}

function headingRows(
  depth: number,
  content: MarkdownSpan[],
  prose: number,
  marks: PageMarks,
): MarkdownRow[] {
  const weights = marks.headingWeights;
  const weight = weights[Math.min(depth, weights.length) - 1] ?? "";
  const mark: MarkdownSpan = { text: `${weight} `, tone: "headingMark" };
  return proseRows(content, prose, [mark]);
}

function listRows(
  indent: string,
  marker: string,
  content: MarkdownSpan[],
  prose: number,
): MarkdownRow[] {
  const lead: MarkdownSpan = { text: `${indent}${marker} `, tone: "listMarker" };
  return proseRows(content, prose, [lead]);
}

function ruleRow(prose: number, marks: PageMarks): MarkdownRow {
  return { spans: [{ text: marks.rule.repeat(prose), tone: "rule" }], panel: false };
}

function fenceHeadRow(rail: MarkdownSpan, language: string): MarkdownRow {
  const spans: MarkdownSpan[] = [rail];
  if (language !== "") spans.push({ text: language, tone: "fenceTag" });
  return { spans, panel: true };
}

function fenceRows(
  rail: MarkdownSpan,
  code: Highlighter,
  line: string,
  bleed: number,
  link: SpanLinker,
): MarkdownRow[] {
  const room = Math.max(1, bleed - width(rail.text));
  const highlighted = code
    .line(line)
    .map((span): MarkdownSpan => ({ text: span.text, tone: span.syntax ?? "fence" }));
  return hardWrapSpans(link(highlighted), room).map((spans) => ({
    spans: [{ ...rail }, ...spans],
    panel: true,
  }));
}

function hardWrapSpans(spans: readonly MarkdownSpan[], cells: number): MarkdownSpan[][] {
  let row: MarkdownSpan[] = [];
  const rows = [row];
  let used = 0;
  for (const span of spans) {
    for (const segment of segments(span.text)) {
      if (used > 0 && used + segment.width > cells) {
        row = [];
        rows.push(row);
        used = 0;
      }
      appendSpan(row, { ...span, text: segment.text });
      used += segment.width;
    }
  }
  return rows;
}

function proseRows(content: MarkdownSpan[], measure: number, lead: MarkdownSpan[]): MarkdownRow[] {
  const hang = lead.reduce((total, span) => total + width(span.text), 0);
  return wrapSpans(content, measure, hang).map((spans, index) => ({
    spans: index === 0 ? [...lead, ...spans] : hanging(hang, spans),
    panel: false,
  }));
}

function hanging(hang: number, spans: MarkdownSpan[]): MarkdownSpan[] {
  if (hang === 0) return spans;
  return [{ text: " ".repeat(hang), tone: "body" }, ...spans];
}

function wrapSpans(content: MarkdownSpan[], measure: number, hang: number): MarkdownSpan[][] {
  const room = Math.max(1, measure - hang);
  const lines: MarkdownSpan[][] = [];
  let line: MarkdownSpan[] = [];
  let used = 0;
  const breakLine = () => {
    trimLineEnd(line);
    lines.push(line);
    line = [];
    used = 0;
  };
  for (const token of tokensOf(content)) {
    const cells = width(token.text);
    if (/^\s+$/.test(token.text)) {
      if (used === 0 && lines.length > 0) continue;
      if (used + cells > room) {
        breakLine();
        continue;
      }
      appendSpan(line, { ...token });
      used += cells;
      continue;
    }
    let piece = token.text;
    while (piece !== "") {
      const remaining = room - used;
      const head = take(piece, remaining);
      if (width(piece) <= remaining) {
        appendSpan(line, { ...token, text: piece });
        used += width(piece);
        break;
      }
      if (used > 0 && (width(piece) <= room || head === "")) {
        breakLine();
        continue;
      }
      const placed = head === "" ? leadingGlyph(piece) : head;
      appendSpan(line, { ...token, text: placed });
      piece = piece.slice(placed.length);
      breakLine();
    }
  }
  if (line.length > 0 || lines.length === 0) {
    trimLineEnd(line);
    lines.push(line);
  }
  return lines;
}

function leadingGlyph(text: string): string {
  return segments(text)[0]?.text ?? text;
}

function trimLineEnd(line: MarkdownSpan[]): void {
  while (line.length > 0) {
    const last = line[line.length - 1];
    if (last === undefined) return;
    last.text = last.text.replace(/\s+$/, "");
    if (last.text !== "") return;
    line.pop();
  }
}

function tokensOf(spans: MarkdownSpan[]): MarkdownSpan[] {
  return spans.flatMap((span) =>
    span.text
      .split(/(\s+)/)
      .filter((piece) => piece !== "")
      .map((piece) => ({ ...span, text: piece })),
  );
}

function appendSpan(spans: MarkdownSpan[], span: MarkdownSpan): void {
  if (span.text === "") return;
  const last = spans.at(-1);
  if (
    last !== undefined &&
    last.tone === span.tone &&
    last.bold === span.bold &&
    last.italic === span.italic &&
    last.href === span.href
  ) {
    last.text += span.text;
    return;
  }
  spans.push(span);
}

interface InlineStyle {
  tone: MarkdownTone;
  bold?: true;
  italic?: true;
}

interface InlineMatch {
  spans: MarkdownSpan[];
  end: number;
}

function inlineSpans(text: string, style: InlineStyle): MarkdownSpan[] {
  const spans: MarkdownSpan[] = [];
  let literal = "";
  let at = 0;
  const flush = () => {
    if (literal !== "") appendSpan(spans, { text: literal, ...style });
    literal = "";
  };
  while (at < text.length) {
    const match =
      codeAt(text, at) ??
      strongAt(text, at, style) ??
      emphasisAt(text, at, style) ??
      linkAt(text, at, style);
    if (match === undefined) {
      literal += text[at];
      at += 1;
      continue;
    }
    flush();
    for (const span of match.spans) appendSpan(spans, span);
    at = match.end;
  }
  flush();
  return spans;
}

function codeAt(text: string, at: number): InlineMatch | undefined {
  if (text[at] !== "`") return undefined;
  let run = 1;
  while (text[at + run] === "`") run += 1;
  const marker = "`".repeat(run);
  let close = text.indexOf(marker, at + run);
  while (close !== -1 && text[close + run] === "`") {
    let beyond = close + run;
    while (text[beyond] === "`") beyond += 1;
    close = text.indexOf(marker, beyond);
  }
  if (close === -1) return undefined;
  const content = text.slice(at + run, close);
  return {
    spans: content === "" ? [] : [{ text: content, tone: "code" }],
    end: close + run,
  };
}

function strongAt(text: string, at: number, style: InlineStyle): InlineMatch | undefined {
  const marker = text.startsWith("**", at) ? "**" : text.startsWith("__", at) ? "__" : undefined;
  if (marker === undefined) return undefined;
  if (marker === "__" && !atWordEdge(text, at - 1)) return undefined;
  const inner = enclosedBy(text, at + 2, marker);
  if (inner === undefined) return undefined;
  const end = at + 2 + inner.length + 2;
  if (marker === "__" && !atWordEdge(text, end)) return undefined;
  return { spans: inlineSpans(inner, { ...style, bold: true }), end };
}

function emphasisAt(text: string, at: number, style: InlineStyle): InlineMatch | undefined {
  const marker = text[at];
  if (marker !== "*" && marker !== "_") return undefined;
  if (text[at + 1] === marker) return undefined;
  if (marker === "_" && !atWordEdge(text, at - 1)) return undefined;
  const inner = enclosedBy(text, at + 1, marker);
  if (inner === undefined) return undefined;
  const end = at + 1 + inner.length + 1;
  if (marker === "_" && !atWordEdge(text, end)) return undefined;
  return { spans: inlineSpans(inner, { ...style, italic: true }), end };
}

function linkAt(text: string, at: number, style: InlineStyle): InlineMatch | undefined {
  if (text[at] !== "[") return undefined;
  const match = linkPattern.exec(text.slice(at));
  if (match === null) return undefined;
  const [whole, label = "", url = ""] = match;
  const spans = inlineSpans(label, { ...style, tone: "link" });
  if (url !== "" && url !== label) appendSpan(spans, { text: ` (${url})`, tone: "linkUrl" });
  return { spans, end: at + whole.length };
}

function enclosedBy(text: string, from: number, marker: string): string | undefined {
  const close = text.indexOf(marker, from);
  if (close <= from) return undefined;
  const content = text.slice(from, close);
  if (/^\s|\s$/.test(content)) return undefined;
  return content;
}

function atWordEdge(text: string, index: number): boolean {
  const character = text[index];
  return character === undefined || !/\w/.test(character);
}
