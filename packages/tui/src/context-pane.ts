import type { AgentContext } from "@keywork/engine";
import { fg, StyledText, Text, type TextChunk } from "@opentui/core";
import { density, type GlyphSupport, resolveRamp } from "./capability.ts";
import {
  basisLine,
  filledShare,
  flushLine,
  type LegendRow,
  legendRows,
  type MapCell,
  mapGrid,
  mapHead,
  pastWindowLine,
} from "./context-map.ts";
import type { Chord } from "./keys.ts";
import { assumedGlyphs } from "./marks.ts";
import type { Palette } from "./palette.ts";
import type { Pane, PaneContext, PaneDescriptor, PaneIntents, PaneView } from "./pane.ts";
import {
  type KeyedTrayCommand,
  type PaneChild,
  paneChrome,
  paneContentHeight,
  paneContentWidth,
  paneTitle,
  trayCommandsPressing,
  wrappedLines,
} from "./pane-chrome.ts";
import { PaneTrayModel, paneTrayMouse, paneTrayView, type TrayCommand } from "./pane-tray.ts";
import type { PointerEvent } from "./pointer.ts";
import { clipSpans, padEnd } from "./width.ts";

export interface ContextTarget {
  readonly name: string;
  readonly map: AgentContext | undefined;
  compact?(): void;
}

export interface ContextPort {
  target(): ContextTarget | undefined;
  refresh?(): void;
  subscribe?(changed: () => void): () => void;
}

export interface ContextReadings {
  read(sessionId: string): Promise<AgentContext | undefined>;
  compact?(sessionId: string): Promise<unknown>;
  subscribe?(listener: (sessionId: string) => void): () => void;
  fallback?(): ContextSubject | undefined;
}

export interface ContextSubject {
  readonly name: string;
  readonly sessionId: string | undefined;
}

export function servedContext(
  readings: ContextReadings,
  focused: () => ContextSubject | undefined,
): ContextPort {
  const maps = new Map<string, AgentContext>();
  const asked = new Set<string>();
  const listeners = new Set<() => void>();
  const read = (sessionId: string): void => {
    asked.add(sessionId);
    void readings
      .read(sessionId)
      .then((map) => {
        if (map !== undefined) maps.set(sessionId, map);
      })
      .catch(() => {})
      .finally(() => {
        for (const listener of listeners) listener();
      });
  };
  const compactOf = (sessionId: string) => {
    const compact = readings.compact;
    if (compact === undefined) return {};
    return { compact: () => void compact(sessionId).then(() => read(sessionId)) };
  };
  return {
    target: () => {
      const subject = focused();
      if (subject?.sessionId === undefined)
        return subject && { name: subject.name, map: undefined };
      const { sessionId, name } = subject;
      if (!asked.has(sessionId)) read(sessionId);
      return { name, map: maps.get(sessionId), ...compactOf(sessionId) };
    },
    refresh: () => {
      const sessionId = focused()?.sessionId;
      if (sessionId !== undefined) read(sessionId);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      const stop = readings.subscribe?.((sessionId) => {
        if (asked.has(sessionId)) read(sessionId);
      });
      return () => {
        listeners.delete(listener);
        stop?.();
      };
    },
  };
}

export const contextKeyHint = "c compacts now · f says when memory flushes · r rereads";

export const noTargetLine = "no conversation to map · focus a session and this pane follows it";

export const unreadLine = "no reading of this window yet · it fills in after the first turn";

export class ContextPane implements Pane {
  readonly tray: PaneTrayModel;
  private readonly unsubscribe: (() => void) | undefined;
  private notice: string | undefined;
  private trayFirstRow = 0;

  constructor(
    readonly id: string,
    private readonly notify: () => void,
    private readonly intents: Pick<PaneIntents, "notice">,
    private readonly port: ContextPort,
  ) {
    this.tray = new PaneTrayModel(notify, () => this.trayCommands());
    this.unsubscribe = port.subscribe?.(notify);
  }

  title(): string {
    const map = this.port.target()?.map;
    return paneTitle("context", map === undefined ? undefined : filledShare(map));
  }

  describe(): PaneDescriptor {
    return { kind: "context" };
  }

  handleKey(chord: Chord, sequence?: string): boolean {
    if (this.tray.open) return this.tray.handleKey(chord, sequence);
    if (this.tray.opensOn(chord)) {
      this.tray.openTray();
      return true;
    }
    if (chord.ctrl || chord.meta || chord.shift) return false;
    switch (chord.name) {
      case "c":
        return this.compact();
      case "f":
        return this.say(flushLine(this.port.target()?.map));
      case "r":
        this.port.refresh?.();
        return this.say(undefined);
      default:
        return false;
    }
  }

  handleMouse(local: { x: number; y: number }, event: PointerEvent): boolean {
    return this.tray.open ? paneTrayMouse(this.tray, this.trayFirstRow, local, event) : false;
  }

  revealed(): void {
    this.port.refresh?.();
  }

  dispose(): void {
    this.unsubscribe?.();
  }

  view(context: PaneContext): PaneView {
    const { theme } = context;
    const room = paneContentWidth(context);
    const tray = this.tray.open ? paneTrayView(this.tray, room, theme, context.glyphs) : undefined;
    const rows = Math.max(0, paneContentHeight(context) - (tray?.rows ?? 0));
    const trailer = this.trailerLines(theme, room);
    const reading = this.readingLines(context, room).slice(0, Math.max(0, rows - trailer.length));
    const body = [...reading, ...trailer].slice(0, rows);
    this.trayFirstRow = 2 + body.length;
    return paneChrome(context, this.title(), ...body, ...(tray?.children ?? []));
  }

  private trailerLines(theme: Palette, room: number): PaneChild[] {
    return [
      ...(this.notice === undefined ? [] : wrappedLines(this.notice, theme.accent, room)),
      ...wrappedLines(contextKeyHint, theme.textDim, room),
    ];
  }

  private readingLines(context: PaneContext, room: number): PaneChild[] {
    const { theme } = context;
    const target = this.port.target();
    if (target === undefined) return wrappedLines(noTargetLine, theme.textDim, room);
    const map = target.map;
    const head = headLine(target.name, map, theme, room);
    if (map === undefined) return [head, ...wrappedLines(unreadLine, theme.textDim, room)];
    const past = pastWindowLine(map);
    return [
      head,
      ...mapBlock(map, theme, context.glyphs ?? assumedGlyphs, room),
      ...wrappedLines(basisLine(map), theme.textDim, room),
      ...(past === undefined ? [] : wrappedLines(past, theme.textMid, room)),
    ];
  }

  private compact(): true {
    const target = this.port.target();
    if (target?.compact === undefined) return this.say("nothing to compact · no session here");
    target.compact();
    return this.say("compacting · the summary lands in the conversation");
  }

  private say(text: string | undefined): true {
    this.notice = text;
    if (text !== undefined) this.intents.notice?.(text);
    this.notify();
    return true;
  }

  private trayCommands(): TrayCommand[] {
    return trayCommandsPressing((chord) => this.handleKey(chord), contextTray);
  }
}

export const contextTray: readonly KeyedTrayCommand[] = [
  { name: "compact", description: "compact the mapped session now", key: "c" },
  { name: "flush", description: "say where memory flushes for the mapped session", key: "f" },
  { name: "refresh", description: "reread the context window", key: "r" },
];

interface CellInk {
  readonly glyph: string;
  readonly ink: string;
}

const gridWidth = 20;
const legendGap = 3;
const legendBeside = gridWidth + legendGap + 32;

function headLine(name: string, map: AgentContext | undefined, theme: Palette, room: number) {
  const tally = map === undefined ? "" : ` · ${mapHead(map)}`;
  return Text({
    content: new StyledText(clipSpans([fg(theme.text)(name), fg(theme.textMid)(tally)], room)),
  });
}

function mapBlock(map: AgentContext, theme: Palette, glyphs: GlyphSupport, room: number) {
  const inks = cellInks(theme, glyphs);
  const grid = mapGrid(map).map((row) => row.flatMap((cell) => cellChunk(inks[cell])));
  const legend = legendRows(map).map((row) => legendChunks(row, inks, theme));
  if (room >= legendBeside) {
    const height = Math.max(grid.length, legend.length);
    return Array.from({ length: height }, (_, at) =>
      styledLine(
        [
          ...(grid[at] ?? [fg(theme.textDim)(" ".repeat(gridWidth))]),
          fg(theme.textDim)(" ".repeat(legendGap)),
          ...(legend[at] ?? []),
        ],
        room,
      ),
    );
  }
  return [...grid, [], ...legend].map((chunks) => styledLine(chunks, room));
}

function cellChunk(ink: CellInk): TextChunk[] {
  return [fg(ink.ink)(ink.glyph)];
}

function legendChunks(
  row: LegendRow,
  inks: Readonly<Record<MapCell, CellInk>>,
  theme: Palette,
): TextChunk[] {
  const fenced = row.share === "";
  return [
    fg(inks[row.cell].ink)(inks[row.cell].glyph),
    fg(fenced ? theme.textDim : theme.text)(` ${padEnd(row.label, 18)}`),
    fg(theme.textMid)(row.amount.padStart(7)),
    fg(theme.textDim)(fenced ? "" : row.share.padStart(5)),
  ];
}

function styledLine(chunks: TextChunk[], room: number): PaneChild {
  if (chunks.length === 0) return Text({ content: " " });
  return Text({ content: new StyledText(clipSpans(chunks, room)) });
}

function cellInks(theme: Palette, glyphs: GlyphSupport): Readonly<Record<MapCell, CellInk>> {
  const [light = ".", medium = ":", heavy = "+", full = "#"] = resolveRamp(density, glyphs);
  const free = glyphs.glyphTier >= 1 ? "· " : ". ";
  const twice = (glyph: string) => `${glyph}${glyph}`;
  return {
    system: { glyph: twice(heavy), ink: theme.textMid },
    tools: { glyph: twice(medium), ink: theme.textMid },
    injected: { glyph: twice(heavy), ink: theme.ramp[1] ?? theme.accentSoft },
    conversation: { glyph: twice(full), ink: theme.accent },
    free: { glyph: free, ink: theme.textDim },
    flush: { glyph: twice(light), ink: theme.textDim },
    compaction: { glyph: twice(medium), ink: theme.textDim },
  };
}
