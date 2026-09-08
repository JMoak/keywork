import { clampScroll } from "./clamp.ts";
import { type MarkdownRow, type MarkdownSpan, markdownBlocks, renderMarkdown } from "./markdown.ts";
import { defaultPageMarks, type PageMarks } from "./marks.ts";
import { inkAt } from "./motion.ts";
import { columnPage, type PageGrammar, proseWidth } from "./page.ts";
import {
  type AssistantEntry,
  type ThinkingEntry,
  type ToolRun,
  type TranscriptEntry,
  thinkingRowSpans,
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
  anchorTotal?: number;
  revealAt?: number;
  backtrackAt?: number;
  foldCursor?: number;
}

export interface Frame {
  lines: TranscriptLine[];
  scrollBack: number;
  total: number;
}

export type MarkdownRenderer = typeof renderMarkdown;

export class TranscriptView {
  private readonly index = new RowIndex();

  constructor(private readonly markdown: MarkdownRenderer = renderMarkdown) {}

  frame(source: TranscriptSource, geometry: FrameGeometry, viewport: Viewport): Frame {
    const { entries } = source;
    const layout = this.index.adopt(layoutOf(geometry));
    this.index.sync(entries, (entry, slot) => this.settled(entry, slot, layout, source));
    const countAt = (at: number): number => this.index.countAt(at);
    const linesAt = (at: number): TranscriptLine[] =>
      highlighted(at, viewport, this.linesAt(at, layout, source));
    const scrollBack =
      viewport.revealAt === undefined
        ? anchoredScrollBack(viewport, this.index.total)
        : revealScroll(entries.length, countAt, viewport.revealAt, geometry.rows);
    return {
      ...windowFromEnd(entries.length, countAt, linesAt, scrollBack, geometry.rows),
      total: this.index.total,
    };
  }

  private linesAt(at: number, layout: Layout, source: TranscriptSource): TranscriptLine[] {
    const slot = this.index.slotAt(at);
    if (slot === undefined) return [];
    const streaming = source.streamingProgress(slot.entry);
    const stamped = restamped(slot, stampFor(slot.entry, layout.marks, streaming));
    this.index.replace(at, stamped);
    return streaming === undefined ? stamped.lines : withStreamCursor(stamped.lines, layout.marks);
  }

  private settled(
    entry: TranscriptEntry,
    slot: Slot | undefined,
    layout: Layout,
    source: TranscriptSource,
  ): Slot {
    const stamp = stampFor(entry, layout.marks, source.streamingProgress(entry));
    if (slot === undefined || slot.entry !== entry) return this.rendered(entry, layout, stamp);
    if (entry.kind === "assistant") return this.flowed(slot, entry, layout, stamp);
    return this.rendered(entry, layout, stamp);
  }

  private rendered(entry: TranscriptEntry, layout: Layout, stamp: string): Slot {
    const shape = shapeOf(entry);
    if (entry.kind === "assistant") {
      const blocks = markdownBlocks(entry.text).map((source) => this.block(source, entry, layout));
      return { entry, shape, blocks, lines: stampHead(blockLines(blocks), stamp) };
    }
    const lines = entryLines(entry, layout).map((line) => railed(line, entry));
    return { entry, shape, blocks: [], lines: stampHead(lines, stamp) };
  }

  private flowed(slot: Slot, entry: AssistantEntry, layout: Layout, stamp: string): Slot {
    const text = entry.text;
    const settled = text.startsWith(slot.shape.text) ? slot.blocks.slice(0, -1) : [];
    const settledLength = settled.reduce((sum, block) => sum + block.source.length + 1, 0);
    const tail = slot.blocks.at(-1);
    const grown = markdownBlocks(text.slice(settledLength)).map((source) =>
      source === tail?.source ? tail : this.block(source, entry, layout),
    );
    const blocks = [...settled, ...grown];
    return { entry, shape: shapeOf(entry), blocks, lines: stampHead(blockLines(blocks), stamp) };
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
): Pick<Frame, "lines" | "scrollBack"> {
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
    const lines =
      entry.kind === "user" ? promptedLines(entry.text, width) : plainLines(entry.text, width);
    return lines.map((text) => ({ kind: entry.kind, failed, text }));
  });
}

const promptMark = "› ";
const promptHang = " ".repeat(promptMark.length);

function plainLines(text: string, width: number): string[] {
  return text.split("\n").flatMap((line) => wrap(line, width));
}

function promptedLines(text: string, width: number): string[] {
  return plainLines(text, Math.max(1, width - promptMark.length)).map((line, index) =>
    index === 0 ? `${promptMark}${line}` : `${promptHang}${line}`,
  );
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

interface Slot {
  entry: TranscriptEntry;
  shape: Shape;
  blocks: RenderedBlock[];
  lines: TranscriptLine[];
}

type SlotRenderer = (entry: TranscriptEntry, current: Slot | undefined) => Slot;

class RowIndex {
  total = 0;
  private slots: Slot[] = [];
  private layout: Layout | undefined;

  adopt(layout: Layout): Layout {
    if (this.layout !== undefined && sameLayout(this.layout, layout)) return this.layout;
    this.layout = layout;
    this.slots = [];
    this.total = 0;
    return layout;
  }

  sync(entries: readonly TranscriptEntry[], render: SlotRenderer): void {
    this.truncate(entries.length);
    for (let at = 0; at < entries.length; at += 1) {
      const entry = entries[at] as TranscriptEntry;
      const slot = this.slots[at];
      if (slot !== undefined && slot.entry === entry && sameShape(slot.shape, entry)) continue;
      this.replace(at, render(entry, slot));
    }
  }

  countAt(at: number): number {
    return this.slots[at]?.lines.length ?? 0;
  }

  slotAt(at: number): Slot | undefined {
    return this.slots[at];
  }

  replace(at: number, slot: Slot): void {
    this.total += slot.lines.length - this.countAt(at);
    this.slots[at] = slot;
  }

  private truncate(count: number): void {
    while (this.slots.length > count) this.total -= this.slots.pop()?.lines.length ?? 0;
  }
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
    folded: foldedOf(entry),
  };
}

function foldedOf(entry: TranscriptEntry): boolean {
  switch (entry.kind) {
    case "tool":
      return entry.run?.folded !== false;
    case "thinking":
      return entry.folded;
    default:
      return true;
  }
}

function sameShape(shape: Shape, entry: TranscriptEntry): boolean {
  return (
    shape.text === entry.text &&
    shape.failed === (entry.kind === "tool" && entry.failed) &&
    shape.folded === foldedOf(entry)
  );
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

function restamped(slot: Slot, stamp: string): Slot {
  if (slot.lines[0]?.stamp === stamp) return slot;
  return { ...slot, lines: stampHead([...slot.lines], stamp) };
}

function stampFor(entry: TranscriptEntry, marks: PageMarks, streaming: number | undefined): string {
  switch (entry.kind) {
    case "user":
      return `${marks.voice.user} `;
    case "assistant":
      return streaming === undefined
        ? `${marks.voice.agent} `
        : `${inkAt(marks.streamRamp, streaming)} `;
    case "thinking":
      return `${marks.voice.agent} `;
    case "tool":
      return `${entry.run?.provenance === "user" ? marks.voice.user : marks.voice.machine} `;
    case "error":
      return `${marks.voice.machine} `;
    case "info":
      return railBlank;
  }
}

function anchoredScrollBack(viewport: Viewport, total: number): number {
  if (viewport.scrollBack === 0 || viewport.anchorTotal === undefined) return viewport.scrollBack;
  return viewport.scrollBack + Math.max(0, total - viewport.anchorTotal);
}

function withStreamCursor(lines: TranscriptLine[], marks: PageMarks): TranscriptLine[] {
  const last = lines.at(-1);
  if (last === undefined) return lines;
  const cursor = marks.streamCursor;
  const cued: TranscriptLine = {
    ...last,
    text: `${last.text}${cursor}`,
    ...(last.spans !== undefined && {
      spans: [...last.spans, { text: cursor, tone: "meta" as const }],
    }),
  };
  return [...lines.slice(0, -1), cued];
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
    case "thinking":
      return thinkingEntryLines(entry, layout);
    case "error":
      return transcriptLines([entry], layout.body);
    case "user":
    case "info":
      return proseEntryLines(entry, layout);
  }
}

function thinkingEntryLines(entry: ThinkingEntry, layout: Layout): TranscriptLine[] {
  const spans = clipSpans(thinkingRowSpans(entry), layout.body, { text: "…", tone: "meta" });
  const row: TranscriptLine = { kind: "thinking", failed: false, text: spanText(spans), spans };
  if (entry.folded) return [row];
  const gutter = " ".repeat(layout.page.proseGutter);
  const body = entry.text
    .split("\n")
    .flatMap((line) => wrap(line, layout.prose))
    .map((text) => metaLine("thinking", text === "" ? "" : `${gutter}${text}`));
  return [row, ruleLine("thinking", layout), ...body];
}

function ruleLine(kind: TranscriptLine["kind"], layout: Layout): TranscriptLine {
  const text = layout.marks.rule.repeat(Math.max(1, Math.min(layout.body, layout.prose)));
  return { kind, failed: false, text, spans: [{ text, tone: "rule" }] };
}

function metaLine(kind: TranscriptLine["kind"], text: string): TranscriptLine {
  return { kind, failed: false, text, spans: [{ text, tone: "meta" }] };
}

function toolEntryLines(run: ToolRun, failed: boolean, layout: Layout): TranscriptLine[] {
  const spans = clipSpans(toolRowSpans(run), layout.body, { text: "…", tone: "meta" });
  const row: TranscriptLine = { kind: "tool", failed, text: spanText(spans), spans };
  if (run.folded || run.detail === undefined) return [row];
  const detail = [...(run.args === "{}" ? [] : [run.args]), ...run.detail]
    .flatMap((line) => wrap(line, layout.body))
    .map((text) => metaLine("tool", text));
  return [row, ruleLine("tool", layout), ...detail];
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
