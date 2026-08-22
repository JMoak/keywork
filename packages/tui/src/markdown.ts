import { type Highlighter, highlighterFor, type SyntaxClass } from "./highlighter.ts";
import { defaultPageMarks, type PageMarks } from "./marks.ts";

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
): MarkdownRow[] {
  const prose = Math.max(1, proseColumns);
  const bleed = Math.max(1, bleedColumns);
  const rows: MarkdownRow[] = [];
  let fence: Fence | undefined;
  for (const line of source.split("\n")) {
    const head = fenceLine.exec(line);
    if (head !== null) {
      if (fence === undefined) {
        fence = openFence(head[1] ?? "", marks);
        rows.push(fence.head);
      } else {
        fence = undefined;
      }
      continue;
    }
    rows.push(...(fence === undefined ? blockRows(line, prose, marks) : fence.rows(line, bleed)));
  }
  return rows;
}

export function markdownRowText(row: MarkdownRow): string {
  return row.spans.map((span) => span.text).join("");
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

function openFence(language: string, marks: PageMarks): Fence {
  const rail: MarkdownSpan = { text: `${marks.fenceRail} `, tone: "fenceRail" };
  const code = highlighterFor(language);
  return {
    head: fenceHeadRow(rail, language),
    rows: (line, bleed) => fenceRows(rail, code, line, bleed),
  };
}

function blockRows(line: string, prose: number, marks: PageMarks): MarkdownRow[] {
  if (line.trim() === "") return [{ spans: [], panel: false }];
  const heading = headingLine.exec(line);
  if (heading !== null) {
    return headingRows((heading[1] ?? "#").length, heading[2] ?? "", prose, marks);
  }
  if (ruleLine.test(line)) return [ruleRow(prose, marks)];
  const bullet = bulletLine.exec(line);
  if (bullet !== null) return listRows(bullet[1] ?? "", marks.bullet, bullet[2] ?? "", prose);
  const ordered = orderedLine.exec(line);
  if (ordered !== null)
    return listRows(ordered[1] ?? "", ordered[2] ?? "", ordered[3] ?? "", prose);
  return proseRows(inlineSpans(line, { tone: "body" }), prose, []);
}

function headingRows(depth: number, text: string, prose: number, marks: PageMarks): MarkdownRow[] {
  const weights = marks.headingWeights;
  const weight = weights[Math.min(depth, weights.length) - 1] ?? "";
  const mark: MarkdownSpan = { text: `${weight} `, tone: "headingMark" };
  return proseRows(inlineSpans(text, { tone: "heading", bold: true }), prose, [mark]);
}

function listRows(indent: string, marker: string, text: string, prose: number): MarkdownRow[] {
  const lead: MarkdownSpan = { text: `${indent}${marker} `, tone: "listMarker" };
  return proseRows(inlineSpans(text, { tone: "body" }), prose, [lead]);
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
): MarkdownRow[] {
  const room = Math.max(1, bleed - count(rail.text));
  const highlighted = code
    .line(line)
    .map((span): MarkdownSpan => ({ text: span.text, tone: span.syntax ?? "fence" }));
  return hardWrapSpans(highlighted, room).map((spans) => ({
    spans: [rail, ...spans],
    panel: true,
  }));
}

function hardWrapSpans(spans: readonly MarkdownSpan[], width: number): MarkdownSpan[][] {
  const rows: MarkdownSpan[][] = [[]];
  let used = 0;
  for (const span of spans) {
    let points = Array.from(span.text);
    while (points.length > 0) {
      if (used === width) {
        rows.push([]);
        used = 0;
      }
      const take = points.slice(0, width - used);
      appendSpan(rows[rows.length - 1] as MarkdownSpan[], { ...span, text: take.join("") });
      used += take.length;
      points = points.slice(take.length);
    }
  }
  return rows;
}

function proseRows(content: MarkdownSpan[], width: number, lead: MarkdownSpan[]): MarkdownRow[] {
  const hang = lead.reduce((total, span) => total + count(span.text), 0);
  return wrapSpans(content, width, hang).map((spans, index) => ({
    spans: index === 0 ? [...lead, ...spans] : hanging(hang, spans),
    panel: false,
  }));
}

function hanging(hang: number, spans: MarkdownSpan[]): MarkdownSpan[] {
  if (hang === 0) return spans;
  return [{ text: " ".repeat(hang), tone: "body" }, ...spans];
}

function wrapSpans(content: MarkdownSpan[], width: number, hang: number): MarkdownSpan[][] {
  const room = Math.max(1, width - hang);
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
    if (/^\s+$/.test(token.text)) {
      if (used === 0 && lines.length > 0) continue;
      if (used + count(token.text) > room) {
        breakLine();
        continue;
      }
      appendSpan(line, { ...token });
      used += count(token.text);
      continue;
    }
    let piece = token.text;
    while (piece !== "") {
      const length = count(piece);
      const remaining = room - used;
      if (length <= remaining) {
        appendSpan(line, { ...token, text: piece });
        used += length;
        break;
      }
      if (used > 0 && length <= room) {
        breakLine();
        continue;
      }
      const points = Array.from(piece);
      const take = Math.max(1, remaining);
      appendSpan(line, { ...token, text: points.slice(0, take).join("") });
      piece = points.slice(take).join("");
      breakLine();
    }
  }
  if (line.length > 0 || lines.length === 0) {
    trimLineEnd(line);
    lines.push(line);
  }
  return lines;
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
    last.italic === span.italic
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

function count(text: string): number {
  return Array.from(text).length;
}
