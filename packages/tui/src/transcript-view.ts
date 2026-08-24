import { clampScroll } from "./clamp.ts";
import { type MarkdownRow, type MarkdownSpan, markdownBlocks, renderMarkdown } from "./markdown.ts";
import { defaultPageMarks, type PageMarks } from "./marks.ts";
import { inkAt } from "./motion.ts";
import { columnPage, type PageGrammar, proseWidth } from "./page.ts";
import {
  type AssistantEntry,
  type ToolRun,
  type TranscriptEntry,
  toolRowSpans,
} from "./transcript-feed.ts";
import { clipSpans, wrap } from "./width.ts";

export interface TranscriptLine {
  kind: TranscriptEntry["kind"];
  failed: boolean;
  text: string;
  spans?: MarkdownSpan[];
  panel?: true;
  selected?: true;
  stamp?: string;
  source?: TranscriptEntry;
}

export interface TranscriptSource {
  readonly entries: readonly TranscriptEntry[];
  streamingProgress(entry: TranscriptEntry): number | undefined;
}

export interface FrameGeometry {
  width: number;
  rows: number;
  page?: PageGrammar;
  marks?: PageMarks;
}

export interface Viewport {
  scrollBack: number;
  revealAt?: number;
  backtrackAt?: number;
  foldCursor?: number;
}

export interface Frame {
  lines: TranscriptLine[];
  scrollBack: number;
}

export type MarkdownRenderer = typeof renderMarkdown;

export class TranscriptView {
  private readonly cache = new WeakMap<TranscriptEntry, CachedEntry>();

  constructor(private readonly markdown: MarkdownRenderer = renderMarkdown) {}

  frame(source: TranscriptSource, geometry: FrameGeometry, viewport: Viewport): Frame {
    const { entries } = source;
    const layout = layoutOf(geometry);
    const rawLinesAt = (at: number): TranscriptLine[] => {
      const entry = entries[at];
      return entry === undefined
        ? []
        : this.linesOf(entry, layout, source.streamingProgress(entry));
    };
    const countAt = (at: number): number => rawLinesAt(at).length;
    const linesAt = (at: number): TranscriptLine[] => highlighted(at, viewport, rawLinesAt(at));
    const scrollBack =
      viewport.revealAt === undefined
        ? viewport.scrollBack
        : revealScroll(entries.length, countAt, viewport.revealAt, geometry.rows);
    return windowFromEnd(entries.length, countAt, linesAt, scrollBack, geometry.rows);
  }

  private linesOf(
    entry: TranscriptEntry,
    layout: Layout,
    streaming: number | undefined,
  ): TranscriptLine[] {
    const stamp = stampFor(entry, layout.marks, streaming);
    const cached = this.cache.get(entry);
    const next =
      cached !== undefined && sameLayout(cached.layout, layout)
        ? this.refreshed(cached, entry, layout, stamp)
        : this.rendered(entry, layout, stamp);
    this.cache.set(entry, next);
    return next.lines;
  }

  private refreshed(
    cached: CachedEntry,
    entry: TranscriptEntry,
    layout: Layout,
    stamp: string,
  ): CachedEntry {
    if (entry.kind === "assistant") return this.flowed(cached, entry, layout, stamp);
    return sameShape(cached.shape, shapeOf(entry))
      ? restamped(cached, stamp)
      : this.rendered(entry, layout, stamp);
  }

  private rendered(entry: TranscriptEntry, layout: Layout, stamp: string): CachedEntry {
    const shape = shapeOf(entry);
    if (entry.kind === "assistant") {
      const blocks = markdownBlocks(entry.text).map((source) => this.block(source, entry, layout));
      return { layout, shape, blocks, lines: stampHead(blockLines(blocks), stamp) };
    }
    const lines = entryLines(entry, layout).map((line) => railed(line, entry));
    return { layout, shape, blocks: [], lines: stampHead(lines, stamp) };
  }

  private flowed(
    cached: CachedEntry,
    entry: AssistantEntry,
    layout: Layout,
    stamp: string,
  ): CachedEntry {
    const text = entry.text;
    if (text === cached.shape.text) return restamped(cached, stamp);
    const settled = text.startsWith(cached.shape.text) ? cached.blocks.slice(0, -1) : [];
    const settledLength = settled.reduce((sum, block) => sum + block.source.length + 1, 0);
    const tail = cached.blocks.at(-1);
    const grown = markdownBlocks(text.slice(settledLength)).map((source) =>
      source === tail?.source ? tail : this.block(source, entry, layout),
    );
    const blocks = [...settled, ...grown];
    return { layout, shape: shapeOf(entry), blocks, lines: stampHead(blockLines(blocks), stamp) };
  }

  private block(source: string, entry: TranscriptEntry, layout: Layout): RenderedBlock {
    const lines = markdownEntryLines(source, layout, this.markdown).map((line) =>
      railed(line, entry),
    );
    return { source, lines };
  }
}

export function windowFromEnd(
  count: number,
  countAt: (index: number) => number,
  linesAt: (index: number) => TranscriptLine[],
  scrollBack: number,
  rows: number,
): Frame {
  const bottom = scrollBack;
  const top = scrollBack + rows;
  const picked: TranscriptLine[][] = [];
  let seen = 0;
  for (let at = count - 1; at >= 0 && seen < top; at -= 1) {
    const size = countAt(at);
    const low = Math.max(bottom, seen);
    const high = Math.min(top, seen + size);
    if (high > low) picked.push(linesAt(at).slice(size - (high - seen), size - (low - seen)));
    seen += size;
  }
  if (seen < top) {
    const clamped = clampScroll(scrollBack, seen, rows);
    if (clamped !== scrollBack) return windowFromEnd(count, countAt, linesAt, clamped, rows);
  }
  return { lines: picked.reverse().flat(), scrollBack };
}

export function transcriptLines(
  entries: readonly TranscriptEntry[],
  width: number,
): TranscriptLine[] {
  return entries.flatMap((entry) => {
    const failed = entry.kind === "tool" && entry.failed;
    const prefixed = entry.kind === "user" ? `› ${entry.text}` : entry.text;
    return prefixed
      .split("\n")
      .flatMap((line) => wrap(line, width))
      .map((text) => ({ kind: entry.kind, failed, text }));
  });
}

const railWidth = 2;
const railBlank = "  ";

type BlockEntry = Exclude<TranscriptEntry, AssistantEntry>;

interface Layout {
  width: number;
  body: number;
  prose: number;
  page: PageGrammar;
  marks: PageMarks;
}

interface Shape {
  text: string;
  failed: boolean;
  folded: boolean;
}

interface RenderedBlock {
  source: string;
  lines: TranscriptLine[];
}

interface CachedEntry {
  layout: Layout;
  shape: Shape;
  blocks: RenderedBlock[];
  lines: TranscriptLine[];
}

function layoutOf(geometry: FrameGeometry): Layout {
  const page = geometry.page ?? columnPage;
  const body = Math.max(1, geometry.width - railWidth);
  return {
    width: geometry.width,
    body,
    prose: proseWidth(page, body),
    page,
    marks: geometry.marks ?? defaultPageMarks,
  };
}

function sameLayout(left: Layout, right: Layout): boolean {
  return (
    left.width === right.width &&
    left.prose === right.prose &&
    left.page.proseGutter === right.page.proseGutter &&
    left.marks === right.marks
  );
}

function shapeOf(entry: TranscriptEntry): Shape {
  return {
    text: entry.text,
    failed: entry.kind === "tool" && entry.failed,
    folded: entry.kind === "tool" ? entry.run?.folded !== false : true,
  };
}

function sameShape(left: Shape, right: Shape): boolean {
  return left.text === right.text && left.failed === right.failed && left.folded === right.folded;
}

function blockLines(blocks: readonly RenderedBlock[]): TranscriptLine[] {
  return blocks.flatMap((block) => block.lines);
}

function railed(line: TranscriptLine, source: TranscriptEntry): TranscriptLine {
  return { ...line, stamp: railBlank, source };
}

function stampHead(lines: TranscriptLine[], stamp: string): TranscriptLine[] {
  const head = lines[0];
  if (head !== undefined) lines[0] = { ...head, stamp };
  return lines;
}

function restamped(cached: CachedEntry, stamp: string): CachedEntry {
  if (cached.lines[0]?.stamp === stamp) return cached;
  return { ...cached, lines: stampHead([...cached.lines], stamp) };
}

function stampFor(entry: TranscriptEntry, marks: PageMarks, streaming: number | undefined): string {
  switch (entry.kind) {
    case "user":
      return `${marks.voice.user} `;
    case "assistant":
      return streaming === undefined
        ? `${marks.voice.agent} `
        : `${inkAt(marks.streamRamp, streaming)} `;
    case "tool":
    case "error":
      return `${marks.voice.machine} `;
    case "info":
      return railBlank;
  }
}

function highlighted(at: number, viewport: Viewport, lines: TranscriptLine[]): TranscriptLine[] {
  if (at === viewport.backtrackAt) return lines.map((line) => ({ ...line, selected: true }));
  if (at !== viewport.foldCursor) return lines;
  return lines.map((line, index) => (index === 0 ? { ...line, selected: true } : line));
}

function revealScroll(
  count: number,
  countAt: (index: number) => number,
  at: number,
  rows: number,
): number {
  let below = 0;
  for (let index = count - 1; index > at; index -= 1) below += countAt(index);
  return Math.max(0, below + countAt(at) - rows);
}

function entryLines(entry: BlockEntry, layout: Layout): TranscriptLine[] {
  switch (entry.kind) {
    case "tool":
      return entry.run === undefined
        ? transcriptLines([entry], layout.body)
        : toolEntryLines(entry.run, entry.failed, layout);
    case "error":
      return transcriptLines([entry], layout.body);
    case "user":
    case "info":
      return proseEntryLines(entry, layout);
  }
}

function toolEntryLines(run: ToolRun, failed: boolean, layout: Layout): TranscriptLine[] {
  const spans = clipSpans(toolRowSpans(run), layout.body, { text: "…", tone: "meta" });
  const row: TranscriptLine = { kind: "tool", failed, text: spanText(spans), spans };
  if (run.folded || run.detail === undefined) return [row];
  const ruleText = layout.marks.rule.repeat(Math.max(1, Math.min(layout.body, layout.prose)));
  const rule: TranscriptLine = {
    kind: "tool",
    failed: false,
    text: ruleText,
    spans: [{ text: ruleText, tone: "rule" }],
  };
  const detail = [...(run.args === "{}" ? [] : [run.args]), ...run.detail]
    .flatMap((line) => wrap(line, layout.body))
    .map((text) => ({
      kind: "tool" as const,
      failed: false,
      text,
      spans: [{ text, tone: "meta" as const }],
    }));
  return [row, rule, ...detail];
}

function proseEntryLines(entry: BlockEntry, layout: Layout): TranscriptLine[] {
  const gutter = " ".repeat(layout.page.proseGutter);
  return entry.text
    .split("\n")
    .flatMap((line) => wrap(line, layout.prose))
    .map((text) => ({
      kind: entry.kind,
      failed: false,
      text: text === "" ? "" : `${gutter}${text}`,
    }));
}

function markdownEntryLines(
  text: string,
  layout: Layout,
  markdown: MarkdownRenderer,
): TranscriptLine[] {
  const gutter = " ".repeat(layout.page.proseGutter);
  return markdown(text, layout.prose, layout.body, layout.marks).map((row) =>
    markdownLine(row, gutter),
  );
}

function markdownLine(row: MarkdownRow, gutter: string): TranscriptLine {
  const spans =
    row.panel || gutter === "" || row.spans.length === 0
      ? row.spans
      : [{ text: gutter, tone: "body" as const }, ...row.spans];
  return {
    kind: "assistant",
    failed: false,
    text: spanText(spans),
    spans,
    ...(row.panel && { panel: true as const }),
  };
}

function spanText(spans: readonly MarkdownSpan[]): string {
  return spans.map((span) => span.text).join("");
}
