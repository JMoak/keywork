import { type Agent, defaultSigil, type ToolCallPart } from "@keywork/engine";
import { Box, bg, fg, StyledText, Text, type TextChunk } from "@opentui/core";
import type { BotEntry } from "./bots.ts";
import {
  density,
  type GlyphSupport,
  resolveMark,
  resolveRamp,
  type TieredRamp,
  tile,
} from "./capability.ts";
import { rampColor } from "./chroma.ts";
import {
  contextGauge,
  type GaugeStyle,
  gaugeStyleFor,
  type InstrumentTier,
} from "./context-gauge.ts";
import {
  type CommandsPort,
  type CompactionHook,
  ConversationModel,
  type ConversationPorts,
  type SettledOutcome,
  type ThinkingChangeHook,
  type Titler,
} from "./conversation-model.ts";
import type { DiffLine } from "./diff-render.ts";
import type { InputBuffer } from "./input-buffer.ts";
import type { Chord } from "./keys.ts";
import type { MarkdownSpan } from "./markdown.ts";
import { markdownChunk } from "./markdown-ink.ts";
import { assumedGlyphs, type PageMarks, pageMarks } from "./marks.ts";
import { headline, wearsMasthead } from "./masthead.ts";
import { type Animator, inkAt } from "./motion.ts";
import { type PageGrammar, type PageThresholds, pageTierThresholds, resolvePage } from "./page.ts";
import type { LifecycleState, Pane, PaneContext, PaneDescriptor, PaneView } from "./pane.ts";
import {
  type PaneTitle,
  paneChrome,
  paneContentHeight,
  paneContentWidth,
  paneInks,
  paneTitle,
} from "./pane-chrome.ts";
import { type PointerEvent, wheelSteps } from "./pointer.ts";
import type { Theme } from "./theme.ts";
import { type TitleBot, titleSpans } from "./title-bar.ts";
import type { TranscriptLine } from "./transcript-view.ts";
import { trayBox, trayRows } from "./tray.ts";
import { clip, padEnd, width } from "./width.ts";

const askDiffRows = 10;
const mastheadStatusRows = 1;
const clockTickMs = 1000;

const lifecycleRamps = {
  pulse: { tier1: ["▓", "█"], tier0: ["+", "#"] },
  work: { tier1: ["░", "▒", "▓"], tier0: [".", ":", "+"] },
  drain: density,
} satisfies Record<string, TieredRamp>;

interface LifecycleGlyphs {
  readonly pulse: readonly string[];
  readonly work: readonly string[];
  readonly drain: readonly string[];
  readonly finished: string;
  readonly failed: string;
}

export interface ConversationPaneOptions {
  ports?: ConversationPorts;
  initialDraft?: string;
  page?: PageThresholds;
  glyphs?: GlyphSupport;
  animator?: Animator;
  siblingTitles?: () => readonly string[];
  botOf?: (name: string) => BotEntry | undefined;
  masthead?: "on" | "off";
  gauge?: GaugeStyle;
  elevation?: TranscriptElevation;
}

export type TranscriptElevation = "arc-stamps" | "turn-age" | "scroll-map" | "chrome";

export class ConversationPane implements Pane {
  readonly model: ConversationModel;
  private readonly pageThresholds: PageThresholds;
  private readonly glyphs: GlyphSupport;
  private readonly marks: PageMarks;
  private readonly stampGlyphs: LifecycleGlyphs;
  private closed = false;
  private lastLines: readonly TranscriptLine[] = [];
  private lastMaxRows = 0;
  private lastSuggestionCount = 0;
  private suggestionFirstRow = 0;
  private lastFocused = false;

  private readonly animator: Animator | undefined;
  private readonly siblingTitles: (() => readonly string[]) | undefined;
  private readonly botOf: ((name: string) => BotEntry | undefined) | undefined;
  private readonly mastheadEnabled: boolean;
  private readonly gaugeOverride: GaugeStyle | undefined;
  private readonly elevation: TranscriptElevation | undefined;
  private unseen: SettledOutcome | undefined;
  private pulseInk = 1;
  private pulsing = false;
  private drainInk: number | undefined;
  private arrivalInk: number | undefined;
  private groundInk: number | undefined;
  private grounded = false;
  private readonly wake: () => void;
  private clock: ReturnType<typeof setInterval> | undefined;

  constructor(
    readonly id: string,
    agent: Agent | undefined,
    notify: () => void,
    titler?: Titler,
    commands?: CommandsPort,
    options?: ConversationPaneOptions,
  ) {
    this.wake = notify;
    this.model = new ConversationModel(agent, notify, titler, commands, options?.ports);
    this.pageThresholds = options?.page ?? pageTierThresholds;
    this.glyphs = options?.glyphs ?? assumedGlyphs;
    this.marks = pageMarks(this.glyphs);
    this.stampGlyphs = lifecycleGlyphs(this.glyphs);
    this.animator = options?.animator;
    this.siblingTitles = options?.siblingTitles;
    this.botOf = options?.botOf;
    this.mastheadEnabled = options?.masthead !== "off";
    this.gaugeOverride = options?.gauge;
    this.elevation = options?.elevation;
    this.model.onSettled((outcome) => {
      if (!this.lastFocused) this.unseen = outcome;
    });
    if (options?.initialDraft !== undefined) this.model.editor.load(options.initialDraft);
  }

  get sessionId(): string | undefined {
    return this.model.ledger.sessionId;
  }

  set sessionId(id: string | undefined) {
    this.model.ledger.sessionId = id;
  }

  get arc(): string | undefined {
    return this.model.ledger.arc;
  }

  set arc(slug: string | undefined) {
    this.model.ledger.arc = slug;
  }

  get bot(): string | undefined {
    return this.model.ledger.bot;
  }

  set bot(name: string | undefined) {
    this.model.ledger.bot = name;
  }

  describe(): PaneDescriptor {
    return {
      kind: "conversation",
      ...(this.sessionId !== undefined && { sessionId: this.sessionId }),
    };
  }

  title(): string {
    const name = this.model.title ?? this.id;
    const usage = this.model.usageSummary();
    const spinner = this.model.busy ? " ·" : "";
    return usage === "" ? paneTitle(`${name}${spinner}`) : paneTitle(name, `${usage}${spinner}`);
  }

  handleKey(chord: Chord, sequence: string | undefined): boolean {
    return this.model.handleKey(chord, sequence, {
      transcriptRows: Math.max(1, this.lastMaxRows),
      askRows: askDiffRows,
    });
  }

  handlePaste(text: string): boolean {
    return this.model.paste(text);
  }

  handleMouse(local: { x: number; y: number }, event: PointerEvent): boolean {
    if (this.suggestionTrayMouse(local, event)) return true;
    if (event.type === "scroll" && event.scroll !== undefined) {
      const steps = wheelSteps(event.scroll.delta);
      return this.model.scrollBy(event.scroll.direction === "up" ? steps : -steps);
    }
    if (event.type !== "down") return false;
    const entry = this.entryAtRow(local.y - 1)?.source;
    return entry === undefined ? false : this.model.toggleToolFold(entry);
  }

  private suggestionTrayMouse(local: { x: number; y: number }, event: PointerEvent): boolean {
    if (this.lastSuggestionCount === 0) return false;
    const row = local.y - this.suggestionFirstRow;
    if (row < 0 || row >= this.lastSuggestionCount) return false;
    if (event.type === "move" || event.type === "drag") {
      this.model.traySelect(row);
      return true;
    }
    if (event.type !== "down") return false;
    return this.model.trayAccept(row);
  }

  private entryAtRow(contentRow: number): TranscriptLine | undefined {
    const index = contentRow - (this.lastMaxRows - this.lastLines.length);
    if (index < 0 || index >= this.lastLines.length) return undefined;
    return this.lastLines[index];
  }

  confirmMutation(call: ToolCallPart): Promise<boolean> {
    return this.model.confirmMutation(call);
  }

  bindAfterTurn(hook: () => Promise<void>): void {
    this.model.bindAfterTurn(hook);
  }

  bindThinkingChange(hook: ThinkingChangeHook): void {
    this.model.bindThinkingChange(hook);
  }

  bindCompaction(hook: CompactionHook): void {
    this.model.bindCompaction(hook);
  }

  postNotice(text: string): void {
    this.model.postNotice(text);
  }

  liveStatus(context: Partial<Pick<PaneContext, "instruments" | "costs" | "focused">>): string {
    return [
      this.workSegment(),
      this.model.pendingAsk === undefined ? "" : "needs you",
      queuedSegment(this.model.queued().length),
      this.contextSegment(context.instruments ?? "calm", context.focused !== false),
      context.costs === true ? this.model.usageSummary() : "",
      this.unseen === "failed" ? "failed" : "",
    ]
      .filter((segment) => segment !== "")
      .join(" · ");
  }

  private workSegment(): string {
    if (!this.model.busy) return "";
    const tool = this.model.activeTool();
    const elapsed = this.model.turnElapsedMs();
    const doing = tool === undefined ? "thinking" : tool.name;
    return elapsed === undefined ? doing : `${doing} · ${elapsedLabel(elapsed)}`;
  }

  private contextSegment(instruments: InstrumentTier, focused: boolean): string {
    const reading = this.model.contextReading();
    if (reading === undefined) return "";
    const significant =
      this.gaugeOverride !== undefined ||
      instruments === "cockpit" ||
      reading.used * 2 >= reading.flushAt;
    if (!significant) return "";
    return contextGauge(reading, {
      style: this.gaugeOverride ?? gaugeStyleFor(instruments, focused),
      glyphs: this.glyphs,
    });
  }

  submitPrompt(text: string): void {
    this.model.submitText(text);
  }

  adoptTitle(title: string): void {
    this.model.adoptTitle(title);
  }

  adoptPromptId(entryId: string): void {
    this.model.adoptPromptId(entryId);
  }

  titled(): string | undefined {
    return this.model.title;
  }

  currentAgent(): Agent | undefined {
    return this.model.currentAgent();
  }

  swapAgent(agent: Agent): void {
    this.model.swapAgent(agent);
  }

  discloseRetrieval(text: string): void {
    this.model.discloseRetrieval(text);
  }

  private syncClock(): void {
    if (this.model.busy && this.clock === undefined) {
      this.clock = setInterval(this.wake, clockTickMs);
      this.clock.unref?.();
    } else if (!this.model.busy) {
      this.stopClock();
    }
  }

  private stopClock(): void {
    if (this.clock !== undefined) clearInterval(this.clock);
    this.clock = undefined;
  }

  dispose(): void {
    this.closed = true;
    this.stopClock();
    this.animator?.settleRegion(`stamp:${this.id}`);
    this.animator?.settleRegion(`pulse:${this.id}`);
    this.animator?.settleRegion(`arrive:${this.id}`);
    this.animator?.settleRegion(`ground:${this.id}`);
    this.model.dispose();
  }

  disposed(): boolean {
    return this.closed;
  }

  awaitingYou(): boolean {
    return this.model.pendingAsk !== undefined;
  }

  lifecycle(): LifecycleState {
    if (this.model.pendingAsk !== undefined) return "needs-you";
    if (this.model.busy) return "working";
    if (this.unseen === "failed") return "failed";
    if (this.unseen === "finished") return "finished-unseen";
    return "idle";
  }

  revealed(): void {
    const animator = this.animator;
    if (animator === undefined) return;
    this.arrivalInk = 0;
    animator.play({
      region: `arrive:${this.id}`,
      tempo: "quick",
      shape: "arrival",
      apply: (ink) => {
        this.arrivalInk = ink;
      },
      onSettled: () => {
        this.arrivalInk = undefined;
      },
    });
  }

  async settled(): Promise<void> {
    for (;;) {
      const send = this.model.lastSend;
      const fork = this.model.lastFork;
      await send;
      await fork;
      if (send === this.model.lastSend && fork === this.model.lastFork) return;
    }
  }

  view(context: PaneContext): PaneView {
    this.lastFocused = context.focused;
    this.syncStamp(context.focused);
    this.syncClock();
    const page = resolvePage(context.width, this.pageThresholds);
    return this.wearsMasthead(page, context.focused)
      ? this.mastheadView(context)
      : this.transcriptView(context, page);
  }

  private composedTitle(context: PaneContext): PaneTitle {
    const spans = titleSpans(
      {
        name: this.model.title ?? this.id,
        stamp: this.stampGlyph(),
        arc: this.arc,
        bot: this.titleBot(),
        telemetry: this.liveStatus(context) || undefined,
        siblings: this.siblingTitles?.(),
      },
      context.width,
      context.focused,
      this.pageThresholds,
    );
    return {
      spans,
      state: this.lifecycle(),
      arrival: this.arrivalInk,
      groundArrival: this.groundInk,
      depth: this.chromeDepth(),
    };
  }

  private titleBot(): TitleBot | undefined {
    const name = this.bot;
    if (name === undefined) return undefined;
    return this.botOf?.(name) ?? { sigil: defaultSigil(name), name };
  }

  private syncStamp(focused: boolean): void {
    if (this.unseen !== undefined && focused && this.drainInk === undefined) this.beginDrain();
    this.syncPulse();
    this.syncGround();
  }

  private syncGround(): void {
    if (this.model.pendingAsk === undefined) {
      if (this.grounded) this.animator?.settleRegion(`ground:${this.id}`);
      this.grounded = false;
      this.groundInk = undefined;
      return;
    }
    if (this.grounded) return;
    this.grounded = true;
    const animator = this.animator;
    if (animator === undefined) return;
    this.groundInk = 0;
    animator.play({
      region: `ground:${this.id}`,
      tempo: "quick",
      shape: "arrival",
      apply: (ink) => {
        this.groundInk = ink;
      },
      onSettled: () => {
        this.groundInk = undefined;
      },
    });
  }

  private beginDrain(): void {
    const animator = this.animator;
    if (animator === undefined) {
      this.unseen = undefined;
      return;
    }
    animator.play({
      region: `stamp:${this.id}`,
      tempo: "settle",
      shape: "departure",
      apply: (progress) => {
        this.drainInk = 1 - progress;
      },
      onSettled: () => {
        this.drainInk = undefined;
        this.unseen = undefined;
      },
    });
  }

  private syncPulse(): void {
    const wantsPulse = this.model.pendingAsk !== undefined && this.animator !== undefined;
    if (!wantsPulse) {
      if (this.pulsing) this.animator?.settleRegion(`pulse:${this.id}`);
      this.pulsing = false;
      this.pulseInk = 1;
      return;
    }
    if (this.pulsing) return;
    this.pulsing = true;
    const phase = this.pulseInk >= 1 ? "dim" : "brighten";
    this.animator?.play({
      region: `pulse:${this.id}`,
      tempo: "quick",
      shape: "arrival",
      apply: (progress) => {
        this.pulseInk = phase === "dim" ? 1 - progress : progress;
      },
      onSettled: () => {
        this.pulsing = false;
      },
    });
  }

  private stampGlyph(): string | undefined {
    const glyphs = this.stampGlyphs;
    if (this.model.pendingAsk !== undefined) return inkAt(glyphs.pulse, this.pulseInk);
    if (this.model.busy) return glyphs.work[this.model.activity % glyphs.work.length];
    if (this.drainInk !== undefined) return inkAt(glyphs.drain, this.drainInk);
    if (this.unseen === "failed") return glyphs.failed;
    if (this.unseen === "finished") return glyphs.finished;
    return undefined;
  }

  private wearsMasthead(page: PageGrammar, focused: boolean): boolean {
    return wearsMasthead({
      tier: page.tier,
      focused,
      asking: this.model.pendingAsk !== undefined,
      backtracking: this.model.backtracking(),
      disclosing: this.model.disclosing(),
      failedUnseen: this.unseen === "failed",
      enabled: this.mastheadEnabled,
    });
  }

  private mastheadView(context: PaneContext): PaneView {
    const { theme, focused } = context;
    const innerWidth = paneContentWidth(context);
    const prompt = promptLines(this.model.editor.buffer, focused);
    const head = headline(this.model.title ?? this.id, {
      width: innerWidth,
      rows: Math.max(0, paneContentHeight(context) - mastheadStatusRows - prompt.length),
      glyphs: this.glyphs,
      siblings: this.siblingTitles?.(),
    });
    this.lastLines = [];
    this.lastMaxRows = 0;
    this.lastSuggestionCount = 0;
    return paneChrome(
      context,
      this.composedTitle(context),
      Box(
        { flexGrow: 1, flexDirection: "column", overflow: "hidden" },
        ...head.lines.map((line, row) => {
          const ink = mastheadInk(context, this.lifecycle(), row, head.lines.length);
          const spans = head.dim[row] ?? [];
          return spans.length === 0
            ? Text({ content: line || " ", fg: ink })
            : Text({ content: alternatedLetters(line, spans, ink, theme.background) });
        }),
        Text({
          content: clip(this.mastheadStatus(context), innerWidth),
          fg: theme.textMid,
        }),
      ),
      ...prompt.map((line) => Text({ content: line, fg: focused ? theme.text : theme.textDim })),
    );
  }

  private mastheadStatus(context: PaneContext): string {
    const state = this.model.busy
      ? "working"
      : this.model.entries.at(-1)?.kind === "error"
        ? "failed"
        : "idle";
    const live = this.liveStatus(context);
    return live === "" ? state : `${state} · ${live}`;
  }

  private transcriptView(context: PaneContext, page: PageGrammar): PaneView {
    const { theme, focused } = context;
    const innerWidth = paneContentWidth(context);
    const suggestions = focused ? this.model.suggestions() : [];
    const prompt = promptLines(this.model.editor.buffer, focused);
    const queued = this.model.queued();
    const ask = this.model.pendingAsk;
    const diffRows = ask?.diff === undefined ? [] : this.askDiffRows(theme);
    const keyHint = this.keyHint(theme);
    const trayChromeRows = 2;
    const reservedRows =
      (suggestions.length === 0 ? 0 : suggestions.length + trayChromeRows) +
      prompt.length +
      queued.length +
      diffRows.length +
      keyHint.length +
      (ask === undefined ? 0 : 1) +
      (this.model.scrollBack > 0 ? 1 : 0);
    const maxRows = Math.max(0, paneContentHeight(context) - reservedRows);
    const lines = this.model.visibleTranscript(innerWidth, maxRows, page, this.marks);
    this.lastLines = lines;
    this.lastMaxRows = maxRows;
    const scrollBack = this.model.scrollBack;
    const scrollNoticeRows = scrollBack > 0 && !this.model.backtracking() ? 1 : 0;
    this.lastSuggestionCount = suggestions.length;
    this.suggestionFirstRow = 2 + maxRows + scrollNoticeRows + queued.length;
    return paneChrome(
      context,
      this.composedTitle(context),
      Box(
        { flexGrow: 1, flexDirection: "column", justifyContent: "flex-end", overflow: "hidden" },
        ...lines.map((line, row) =>
          transcriptRow(line, innerWidth, theme, this.rowTint(context, lines, line, row)),
        ),
      ),
      ...(scrollNoticeRows > 0
        ? [
            Text({
              content: `↓ ${scrollBack} more · esc returns to live`,
              fg: theme.textDim,
            }),
          ]
        : []),
      ...queued.map((text, at) =>
        queuedRow(text, at, this.model.queueSelection(), innerWidth, theme),
      ),
      ...(suggestions.length === 0
        ? []
        : [
            trayBox(
              theme,
              trayRows(suggestions, this.model.selectedSuggestion, innerWidth - 2, theme, {
                namePrefix: "/",
                glyphs: this.glyphs,
              }),
            ),
          ]),
      ...diffRows,
      ...(ask === undefined ? [] : [askRow(ask.summary, innerWidth, theme)]),
      ...keyHint,
      ...prompt.map((line) => Text({ content: line, fg: focused ? theme.text : theme.textDim })),
    );
  }

  private keyHint(theme: Theme) {
    if (this.model.backtracking()) {
      return [
        Text({
          content: "backtrack · ↑ older · ↓ newer · enter edit & fork · esc cancel",
          fg: theme.accent,
        }),
      ];
    }
    if (this.model.disclosing()) {
      return [
        Text({
          content: "disclose · tab toggles · shift+tab older · esc done",
          fg: theme.accent,
        }),
      ];
    }
    if (this.model.editingQueue()) return [Text({ content: queueEditHint, fg: theme.accent })];
    if (this.model.busy && !this.model.editor.isEmpty()) {
      return [Text({ content: busyPromptHint, fg: theme.textDim })];
    }
    return [];
  }

  private rowTint(
    context: PaneContext,
    lines: readonly TranscriptLine[],
    line: TranscriptLine,
    row: number,
  ): RowTint | undefined {
    switch (this.elevation) {
      case undefined:
        return undefined;
      case "arc-stamps":
        return line.kind === "user" && line.stamp !== undefined && context.hue !== undefined
          ? { stampInk: context.hue }
          : undefined;
      case "turn-age":
        return { bodyInk: this.agedInk(context.theme, line) };
      case "scroll-map":
        return this.scrollMapTint(context.theme, lines.length, row);
      case "chrome":
        return undefined;
    }
  }

  private chromeDepth(): number | undefined {
    if (this.elevation !== "chrome") return undefined;
    const reading = this.model.contextReading();
    if (reading === undefined || reading.window === 0) return undefined;
    return Math.min(1, reading.used / reading.window);
  }

  private agedInk(theme: Theme, line: TranscriptLine): string {
    const entries = this.model.entries;
    const at = line.source === undefined ? entries.length - 1 : entries.indexOf(line.source);
    const age = entries.length <= 1 ? 1 : Math.max(0, at) / (entries.length - 1);
    return rampColor([theme.textDim, lineColor(line, theme)], 0.35 + 0.65 * age);
  }

  private scrollMapTint(theme: Theme, rows: number, row: number): RowTint | undefined {
    const entries = this.model.entries;
    if (entries.length === 0 || rows === 0) return undefined;
    const entry = entries[Math.min(entries.length - 1, Math.floor((row / rows) * entries.length))];
    if (entry === undefined) return undefined;
    const voice = this.marks.voice;
    const glyph =
      entry.kind === "user" ? voice.user : entry.kind === "assistant" ? voice.agent : voice.machine;
    return {
      stampText: `${glyph} `,
      stampInk: entry.kind === "user" ? theme.accent : theme.textDim,
    };
  }

  private askDiffRows(theme: Theme) {
    const window = this.model.askDiffWindow(askDiffRows);
    return [
      ...(window.above > 0 ? [Text({ content: `↑ ${window.above} more`, fg: theme.textDim })] : []),
      ...window.lines.map((line) => diffRow(line, theme)),
      ...(window.below > 0 ? [Text({ content: `↓ ${window.below} more`, fg: theme.textDim })] : []),
    ];
  }
}

const askControls = "  [y] allow  [a] always  [n] deny";

export const queueEditHint =
  "queue · ↑↓ pick · shift+↑↓ move · backspace cancels · enter sends now · esc done";

function queuedRow(
  text: string,
  at: number,
  selected: number | undefined,
  paneWidth: number,
  theme: Theme,
) {
  const content = `⋯ ${text}`;
  if (at !== selected) return Text({ content, fg: theme.textDim });
  return Text({ content: padEnd(content, paneWidth), fg: theme.background, bg: theme.accent });
}

function askRow(summary: string, paneWidth: number, theme: Theme) {
  const room = Math.max(0, paneWidth - askControls.length - 2);
  return Text({ content: `? ${clip(summary, room)}${askControls}`, fg: theme.accent });
}

interface RowTint {
  readonly stampText?: string;
  readonly stampInk?: string;
  readonly bodyInk?: string;
}

function transcriptRow(line: TranscriptLine, paneWidth: number, theme: Theme, tint?: RowTint) {
  const stamp = tint?.stampText ?? line.stamp ?? "";
  if (line.selected === true) {
    return Text({
      content: padEnd(`${stamp}${line.text || " "}`, paneWidth),
      fg: theme.background,
      bg: theme.accent,
    });
  }
  const lead = stamp === "" ? [] : [fg(tint?.stampInk ?? stampColor(line, theme))(stamp)];
  const bodyWidth = paneWidth - width(stamp);
  if (line.spans !== undefined) {
    if (tint?.bodyInk !== undefined) {
      return Text({
        content: new StyledText([
          ...lead,
          ...line.spans.map((span) => fg(tint.bodyInk as string)(span.text)),
        ]),
      });
    }
    return styledRow(lead, line.spans, line.panel === true, bodyWidth, theme);
  }
  const bodyInk = tint?.bodyInk ?? lineColor(line, theme);
  if (lead.length === 0) return Text({ content: line.text || " ", fg: bodyInk });
  return Text({
    content: new StyledText([...lead, fg(bodyInk)(line.text || " ")]),
  });
}

function stampColor(line: TranscriptLine, theme: Theme): string {
  switch (line.kind) {
    case "user":
      return theme.accent;
    case "assistant":
      return theme.textMid;
    case "thinking":
    case "info":
      return theme.textDim;
    case "tool":
      return line.failed ? theme.error : theme.textDim;
    case "error":
      return theme.error;
  }
}

function styledRow(
  lead: TextChunk[],
  spans: MarkdownSpan[],
  panel: boolean,
  bodyWidth: number,
  theme: Theme,
) {
  if (lead.length === 0 && spans.length === 0) return Text({ content: " " });
  const chunks = [...lead, ...spans.map((span) => markdownChunk(span, theme, panel))];
  if (panel) {
    const filled = spans.reduce((total, span) => total + width(span.text), 0);
    if (filled < bodyWidth) chunks.push(bg(theme.panel)(" ".repeat(bodyWidth - filled)));
  }
  return Text({ content: new StyledText(chunks) });
}

function lifecycleGlyphs(glyphs: GlyphSupport): LifecycleGlyphs {
  const drain = resolveRamp(lifecycleRamps.drain, glyphs);
  return {
    pulse: resolveRamp(lifecycleRamps.pulse, glyphs),
    work: resolveRamp(lifecycleRamps.work, glyphs),
    drain,
    finished: drain.at(-1) ?? "#",
    failed: resolveMark(tile.failed, glyphs),
  };
}

function diffRow(line: DiffLine, theme: Theme) {
  switch (line.kind) {
    case "add":
      return Text({ content: `+ ${line.text}`, fg: theme.success });
    case "del":
      return Text({ content: `- ${line.text}`, fg: theme.error });
    case "context":
      return Text({ content: `  ${line.text}`, fg: theme.text });
    case "hunk":
      return Text({ content: line.text, fg: theme.textDim });
    case "note":
      return Text({ content: `· ${line.text}`, fg: theme.textDim });
  }
}

function promptLines(buffer: InputBuffer, focused: boolean): string[] {
  const lines = buffer.lines();
  const { line: cursorLine, column } = buffer.cursorAt();
  return lines.map((text, index) => {
    const withCursor =
      focused && index === cursorLine ? `${text.slice(0, column)}▌${text.slice(column)}` : text;
    return index === 0 ? `› ${withCursor}` : `  ${withCursor}`;
  });
}

function lineColor(line: TranscriptLine, theme: Theme): string {
  switch (line.kind) {
    case "user":
      return theme.accent;
    case "assistant":
      return theme.text;
    case "thinking":
      return theme.textMid;
    case "tool":
      return line.failed ? theme.error : theme.success;
    case "error":
      return theme.error;
    case "info":
      return theme.textDim;
  }
}

function mastheadInk(
  context: PaneContext,
  state: LifecycleState,
  row: number,
  rows: number,
): string {
  const hue = paneInks(context, { state }).borderColor;
  const depth = rows <= 1 ? 1 : row / (rows - 1);
  return rampColor([hue, context.theme.text], depth);
}

const alternatedDimBlend = 0.35;

function alternatedLetters(
  line: string,
  spans: ReadonlyArray<readonly [number, number]>,
  ink: string,
  ground: string,
): StyledText {
  const dim = rampColor([ink, ground], alternatedDimBlend);
  const chunks: TextChunk[] = [];
  let at = 0;
  for (const [from, to] of spans) {
    const start = Math.min(from, line.length);
    const end = Math.min(to, line.length);
    if (start > at) chunks.push(fg(ink)(line.slice(at, start)));
    if (end > start) chunks.push(fg(dim)(line.slice(start, end)));
    at = Math.max(at, end);
  }
  if (at < line.length) chunks.push(fg(ink)(line.slice(at)));
  return new StyledText(chunks.length === 0 ? [fg(ink)(" ")] : chunks);
}

const busyPromptHint = "enter queues · alt+enter steers · alt+↑ edits the queue · esc interrupts";

function queuedSegment(count: number): string {
  return count === 0 ? "" : `${count} queued`;
}

export function elapsedLabel(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
