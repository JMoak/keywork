import { fg, StyledText, Text, type TextChunk } from "@opentui/core";
import { type ArcAirlockPort, type ArcOrdinals, arcInk, describeFinishOutcome } from "./arcs.ts";
import { FrameCoalescer, type FrameScheduler, nextFrame } from "./frame-scheduler.ts";
import type { Chord } from "./keys.ts";
import { markdownChunk } from "./markdown-ink.ts";
import {
  type MemoryLensState,
  type MemoryPaneInputs,
  MemoryPaneModel,
  type MemoryQueryOutcome,
} from "./memory-pane-model.ts";
import type { DigestTreatment, MemoryRow, SpanInk } from "./memory-rows.ts";
import type { Pane, PaneContext, PaneDescriptor, PaneIntents, PaneView } from "./pane.ts";
import {
  type KeyedTrayCommand,
  type PaneChild,
  paneChrome,
  paneContentHeight,
  paneContentWidth,
  paneFailureLine,
  paneLine,
  paneTitle,
  rowsView,
  toneInk,
  trayCommandsPressing,
} from "./pane-chrome.ts";
import { PaneTasks } from "./pane-tasks.ts";
import { PaneTrayModel, paneTrayView, type TrayCommand } from "./pane-tray.ts";
import { pluralize } from "./pluralize.ts";
import type { PointerEvent } from "./pointer.ts";
import type { Theme } from "./theme.ts";
import { clip, clipSpans, width as textWidth } from "./width.ts";

export type RevertOutcome = "reverted" | "needs-rebase";

export interface MemoryPanePort {
  load(): Promise<MemoryPaneInputs>;
  approve(id: string): Promise<void>;
  discard(id: string): Promise<void>;
  revert?(ledgerId: string): Promise<RevertOutcome>;
  query?(text: string, arc?: string): Promise<MemoryQueryOutcome>;
  airlock?: ArcAirlockPort;
}

export interface MemoryPaneOptions {
  intents?: Pick<PaneIntents, "openFile" | "notice">;
  focusedArc?: () => string | undefined;
  arcOrdinal?: ArcOrdinals;
  digestTreatment?: DigestTreatment;
  subscribe?: (listener: () => void) => () => void;
  now?: () => number;
  scheduleFrame?: FrameScheduler;
  revival?: MemoryLensState;
}

export class MemoryPane implements Pane {
  readonly model: MemoryPaneModel;
  readonly tray: PaneTrayModel;
  private readonly tasks: PaneTasks;
  private readonly pendingAsk: FrameCoalescer;
  private readonly pendingRefresh: FrameCoalescer;
  private readonly unsubscribe: (() => void) | undefined;
  private askText = "";
  private revival: MemoryLensState | undefined;
  private lastPageRows = 20;

  constructor(
    readonly id: string,
    notify: () => void,
    private readonly port: MemoryPanePort,
    private readonly options: MemoryPaneOptions = {},
  ) {
    this.tasks = new PaneTasks(notify);
    this.revival = options.revival;
    const schedule = options.scheduleFrame ?? nextFrame;
    this.pendingAsk = new FrameCoalescer(schedule, () => this.ask());
    this.pendingRefresh = new FrameCoalescer(schedule, () => this.refresh());
    this.model = new MemoryPaneModel(
      () => this.tasks.emit(),
      {
        refresh: () => this.refresh(),
        approve: (id) => this.tasks.track(() => this.drain(() => this.port.approve(id))),
        discard: (id) => this.tasks.track(() => this.drain(() => this.port.discard(id))),
        revert: (ledgerId) => this.tasks.track(() => this.revert(ledgerId)),
        openFile: (path) => this.openFile(path),
        ask: (query) => {
          this.askText = query;
          this.pendingAsk.request();
        },
        notice: (text) => this.notice(text),
        triageCandidate: (arc, note, choice) =>
          this.airlockAct((airlock) => airlock.triageCandidate(arc, note, choice)),
        triageQuestion: (arc, title, choice) =>
          this.airlockAct((airlock) => airlock.triageQuestion(arc, title, choice)),
        deliverEligible: (arc) => this.deliverEligible(arc),
        finishClose: (arc, force) => this.finishClose(arc, force),
      },
      {
        ...(options.focusedArc !== undefined && { focusedArc: options.focusedArc }),
        ...(options.now !== undefined && { now: options.now }),
        ...(options.digestTreatment !== undefined && {
          digestTreatment: options.digestTreatment,
        }),
      },
    );
    this.tray = new PaneTrayModel(
      () => this.tasks.emit(),
      () => this.trayCommands(),
    );
    this.unsubscribe = options.subscribe?.(() => this.pendingRefresh.request());
    this.refresh();
  }

  dispose(): void {
    this.tasks.dispose();
    this.pendingAsk.dispose();
    this.pendingRefresh.dispose();
    this.unsubscribe?.();
  }

  title(): string {
    const notes = this.model.noteCount();
    const staged = this.model.stagedCount();
    const parts = [
      ...(notes === 0 ? [] : [pluralize(notes, "note")]),
      ...(staged === 0 ? [] : [`░${staged}`]),
    ];
    return paneTitle("memory", parts.length === 0 ? undefined : parts.join(" · "));
  }

  describe(): PaneDescriptor {
    const { lens, note, query } = this.model.state();
    return {
      kind: "memory",
      ...(lens !== "garden" && { lens }),
      ...(note !== undefined && { note }),
      ...(query !== undefined && { query }),
    };
  }

  handleKey(chord: Chord, sequence?: string): boolean {
    if (this.tray.open) return this.tray.handleKey(chord, sequence);
    if (!this.model.asking() && this.tray.opensOn(chord)) {
      this.tray.openTray();
      return true;
    }
    return this.model.handleKey(chord, this.lastPageRows, sequence);
  }

  handleMouse(local: { x: number; y: number }, event: PointerEvent): boolean {
    if (event.type !== "down" || this.tasks.failure() !== undefined) return false;
    const row = local.y - 1;
    if (row < 0 || row >= this.lastPageRows) return false;
    return this.model.selectVisible(row, this.lastPageRows);
  }

  settled(): Promise<void> {
    return this.tasks.settled();
  }

  refresh(): void {
    this.tasks.track(async () => {
      const inputs = await this.port.load();
      this.model.setInputs(inputs);
      this.reviveOnce();
    });
  }

  view(context: PaneContext): PaneView {
    const { theme } = context;
    const innerWidth = paneContentWidth(context);
    const tray = this.tray.open ? paneTrayView(this.tray, innerWidth, theme) : undefined;
    this.lastPageRows = Math.max(0, paneContentHeight(context) - (tray?.rows ?? 0));
    this.model.setBodyWidth(Math.max(1, innerWidth - railWidth));
    return paneChrome(
      context,
      this.title(),
      ...this.bodyLines(theme, this.lastPageRows, innerWidth),
      ...(tray?.children ?? []),
    );
  }

  private reviveOnce(): void {
    const revival = this.revival;
    if (revival === undefined) return;
    this.revival = undefined;
    this.model.restore(revival);
  }

  private async drain(act: () => Promise<void>): Promise<void> {
    await act();
    if (!this.tasks.live()) return;
    this.model.setInputs(await this.port.load());
  }

  private async revert(ledgerId: string): Promise<void> {
    const revert = this.port.revert;
    if (revert === undefined) {
      this.notice("reverting isn't available here");
      return;
    }
    const outcome = await revert(ledgerId);
    this.notice(
      outcome === "reverted"
        ? "reverted · the previous text is back"
        : "couldn't revert · the file changed since that write",
    );
    await this.drain(async () => {});
  }

  private airlockAct(act: (airlock: ArcAirlockPort) => Promise<unknown>): void {
    const airlock = this.port.airlock;
    if (airlock === undefined) {
      this.notice("the airlock isn't available here");
      return;
    }
    this.tasks.track(() =>
      this.drain(async () => {
        try {
          await act(airlock);
        } catch (cause) {
          this.notice(cause instanceof Error ? cause.message : String(cause));
        }
      }),
    );
  }

  private deliverEligible(arc: string): void {
    this.airlockAct(async (airlock) => {
      const delivered = await airlock.deliverEligible(arc);
      this.notice(
        `${pluralize(delivered, "eligible note")} marked deliver · the rest stay archived`,
      );
    });
  }

  private finishClose(arc: string, force: boolean): void {
    this.airlockAct(async (airlock) => {
      this.notice(describeFinishOutcome(arc, await airlock.finish(arc, { force })));
    });
  }

  private ask(): void {
    const text = this.askText;
    const query = this.port.query;
    if (text === "") return;
    if (query === undefined) {
      this.model.setQueryOutcome(text, { hits: [], source: "lexical" });
      return;
    }
    this.tasks.track(async () => {
      const outcome = await query(text, this.options.focusedArc?.());
      if (this.tasks.live()) this.model.setQueryOutcome(text, outcome);
    });
  }

  private openFile(path: string): void {
    const open = this.options.intents?.openFile;
    if (open === undefined) this.notice("opening files isn't available here");
    else open(path);
  }

  private notice(text: string): void {
    this.options.intents?.notice?.(text);
  }

  private bodyLines(theme: Theme, rows: number, width: number): PaneChild[] {
    const failure = this.tasks.failure();
    if (failure !== undefined) return [paneFailureLine(failure, theme, width)];
    return rowsView(this.model, rows, theme, width, {
      text: (row) => `${railText(row, false)}${row.text}`,
      line: (row) => this.paintRow(row, theme, width, false),
      selected: (row) => (row.kind === "body" ? this.paintRow(row, theme, width, true) : undefined),
    });
  }

  private paintRow(row: MemoryRow, theme: Theme, width: number, cursored: boolean): PaneChild {
    const rail = railText(row, cursored);
    if (row.kind === "state") return this.paintStateRow(row, theme, width);
    if (row.markdown !== undefined) {
      const chunks = [
        fg(theme.accent)(rail),
        ...row.markdown.spans.map((span) =>
          markdownChunk(span, theme, row.markdown?.panel === true),
        ),
      ];
      return styled(chunks, width);
    }
    if (row.spans === undefined) {
      return paneLine(`${rail}${row.text}`, toneInk(theme, row.tone), width);
    }
    const chunks = [
      fg(theme.accent)(rail),
      ...row.spans.map((span) => fg(this.inkOf(span.ink, row, theme))(span.text)),
    ];
    return styled(chunks, width);
  }

  private paintStateRow(row: MemoryRow, theme: Theme, width: number): PaneChild {
    const spans = row.spans ?? [];
    const hint = spans.at(-1);
    const facts = spans.slice(0, -1).map((span) => span.text);
    if (hint === undefined || facts.length === 0) {
      return paneLine(row.text, toneInk(theme, row.tone), width);
    }
    const hintCells = textWidth(hint.text);
    const factsRoom = width - hintCells - hintGap;
    if (factsRoom < minimumFactsRoom) {
      return paneLine(clip(facts.join(" · "), width), theme.textMid, width);
    }
    const shown = factsWithin(facts, factsRoom);
    const gap = " ".repeat(Math.max(hintGap, width - textWidth(shown) - hintCells));
    return styled([fg(theme.textMid)(shown), fg(theme.textDim)(`${gap}${hint.text}`)], width);
  }

  private inkOf(ink: SpanInk, row: MemoryRow, theme: Theme): string {
    switch (ink) {
      case "text":
        return theme.text;
      case "mid":
        return theme.textMid;
      case "dim":
        return theme.textDim;
      case "heading":
        return theme.accentSoft;
      case "accent":
        return theme.accent;
      case "arc":
        return arcInk(
          theme,
          row.arc === undefined ? undefined : this.options.arcOrdinal?.(row.arc),
        );
    }
  }

  private trayCommands(): TrayCommand[] {
    return trayCommandsPressing((chord) => this.handleKey(chord), memoryTray);
  }
}

const railWidth = 2;
const cursorRail = "▌ ";
const restingRail = "  ";
const hintGap = 2;
const minimumFactsRoom = 12;

const memoryTray: readonly KeyedTrayCommand[] = [
  { name: "open", description: "open the selected note, hit, or ledger subject", key: "enter" },
  { name: "back", description: "leave the note or ledger lens", key: "escape" },
  {
    name: "ask",
    description: "ask memory what it knows, ranked the way the agent sees it",
    key: "?",
  },
  { name: "lens", description: "switch between the garden and the ledger", key: "tab" },
  { name: "ledger", description: "the event ledger, filtered to the open note", key: "l" },
  { name: "open file", description: "open the note's file in a file pane", key: "o" },
  { name: "revert", description: "revert the note's last write from this run", key: "u" },
  {
    name: "approve",
    description: "approve the selected inbox item · deliver or resolve an airlock item",
    key: "a",
  },
  {
    name: "discard",
    description: "discard the selected inbox item · leave or drop an airlock item",
    key: "d",
  },
  { name: "carry", description: "carry the selected open question into the newest arc", key: "c" },
  { name: "unfold", description: "show or hide the notes below the delivery bar", key: "space" },
  { name: "force close", description: "close the arc past sessions that didn't flush", key: "f" },
  { name: "inbox", description: "jump to the review inbox", key: "i" },
  { name: "refresh", description: "reload the vault", key: "r" },
];

function factsWithin(facts: readonly string[], cells: number): string {
  let line = "";
  for (const fact of facts) {
    const next = line === "" ? fact : `${line} · ${fact}`;
    if (textWidth(next) > cells) break;
    line = next;
  }
  return line === "" ? clip(facts[0] ?? "", cells) : line;
}

function railText(row: MemoryRow, cursored: boolean): string {
  if (row.rail !== true) return "";
  return cursored ? cursorRail : restingRail;
}

function styled(chunks: TextChunk[], width: number): PaneChild {
  return Text({ content: new StyledText(clipSpans(chunks, width)) });
}
