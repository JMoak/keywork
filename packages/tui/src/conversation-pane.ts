import type { Agent, ToolCallPart } from "@keywork/engine";
import {
  Box,
  bg,
  bold,
  fg,
  italic,
  StyledText,
  Text,
  type TextChunk,
  underline,
} from "@opentui/core";
import {
  type CommandsPort,
  ConversationModel,
  type ConversationPorts,
  type Titler,
  type TranscriptLine,
} from "./conversation-model.ts";
import type { DiffLine } from "./diff-render.ts";
import type { InputBuffer } from "./input-buffer.ts";
import type { Chord } from "./keys.ts";
import type { MarkdownSpan, MarkdownTone } from "./markdown.ts";
import { type Animator, inkAt } from "./motion.ts";
import { type PageThresholds, pageTierThresholds, resolvePage } from "./page.ts";
import type { Pane, PaneContext, PaneDescriptor, PaneView } from "./pane.ts";
import { paneChrome, paneContentHeight, paneContentWidth, paneTitle } from "./pane-chrome.ts";
import { type PointerEvent, wheelSteps } from "./pointer.ts";
import type { Theme } from "./theme.ts";
import { titleBar } from "./title-bar.ts";
import { trayBox, trayRows } from "./tray.ts";

const askDiffRows = 10;
const pulseRamp = ["▓", "█"] as const;
const workRamp = ["░", "▒", "▓"] as const;
const drainRamp = ["░", "▒", "▓", "█"] as const;

export interface ConversationPaneOptions {
  ports?: ConversationPorts;
  initialDraft?: string;
  page?: PageThresholds;
  animator?: Animator;
  siblingTitles?: () => readonly string[];
}

export class ConversationPane implements Pane {
  sessionId: string | undefined;
  private readonly model: ConversationModel;
  private readonly pageThresholds: PageThresholds;
  private closed = false;
  private lastLines: readonly TranscriptLine[] = [];
  private lastMaxRows = 0;

  private readonly animator: Animator | undefined;
  private readonly siblingTitles: (() => readonly string[]) | undefined;
  private wasBusy = false;
  private unseen: "finished" | "failed" | undefined;
  private pulseInk = 1;
  private pulsing = false;
  private drainInk: number | undefined;

  constructor(
    readonly id: string,
    agent: Agent | undefined,
    notify: () => void,
    titler?: Titler,
    commands?: CommandsPort,
    options?: ConversationPaneOptions,
  ) {
    this.model = new ConversationModel(agent, notify, titler, commands, options?.ports);
    this.pageThresholds = options?.page ?? pageTierThresholds;
    this.animator = options?.animator;
    this.siblingTitles = options?.siblingTitles;
    if (options?.initialDraft !== undefined) this.model.buffer.load(options.initialDraft);
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
    return this.model.handleKey(chord, sequence);
  }

  handlePaste(text: string): boolean {
    return this.model.paste(text);
  }

  handleMouse(local: { x: number; y: number }, event: PointerEvent): boolean {
    if (event.type === "scroll" && event.scroll !== undefined) {
      const steps = wheelSteps(event.scroll.delta);
      return this.model.scrollBy(event.scroll.direction === "up" ? steps : -steps);
    }
    if (event.type !== "down") return false;
    const entry = this.entryAtRow(local.y - 1)?.source;
    return entry === undefined ? false : this.model.toggleToolFold(entry);
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

  submitPrompt(text: string): void {
    this.model.submitText(text);
  }

  adoptTitle(title: string): void {
    this.model.adoptTitle(title);
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

  dispose(): void {
    this.closed = true;
    this.model.dispose();
  }

  disposed(): boolean {
    return this.closed;
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

  private composedTitle(context: PaneContext): string {
    this.observeLifecycle(context);
    return titleBar(
      {
        name: this.model.title ?? this.id,
        stamp: this.stampGlyph(),
        telemetry: this.model.usageSummary() || undefined,
        siblings: this.siblingTitles?.(),
      },
      context.width,
      context.focused,
    );
  }

  private observeLifecycle(context: PaneContext): void {
    const settledNow = this.wasBusy && !this.model.busy;
    if (settledNow && !context.focused) {
      this.unseen = this.model.entries.at(-1)?.kind === "error" ? "failed" : "finished";
    }
    this.wasBusy = this.model.busy;
    if (this.unseen !== undefined && context.focused && this.drainInk === undefined) {
      this.beginDrain();
    }
    this.syncPulse();
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
    if (this.model.pendingAsk !== undefined) return inkAt(pulseRamp, this.pulseInk);
    if (this.model.busy) return workRamp[this.model.activity % workRamp.length];
    if (this.drainInk !== undefined) return inkAt(drainRamp, this.drainInk);
    if (this.unseen === "failed") return "▛";
    if (this.unseen === "finished") return "█";
    return undefined;
  }

  view(context: PaneContext): PaneView {
    const { theme, focused, width, height } = context;
    const innerWidth = paneContentWidth(width);
    const page = resolvePage(width, this.pageThresholds);
    const suggestions = focused ? this.model.suggestions() : [];
    const prompt = promptLines(this.model.buffer, focused);
    const queued = this.model.queued();
    const ask = this.model.pendingAsk;
    const diffRows = ask?.diff === undefined ? [] : this.askDiffRows(theme);
    const backtrackHint = this.model.backtracking()
      ? [
          Text({
            content: "backtrack · ↑ older · ↓ newer · enter edit & fork · esc cancel",
            fg: theme.accent,
          }),
        ]
      : [];
    const trayChromeRows = 2;
    const reservedRows =
      (suggestions.length === 0 ? 0 : suggestions.length + trayChromeRows) +
      prompt.length +
      queued.length +
      diffRows.length +
      backtrackHint.length +
      (ask === undefined ? 0 : 1) +
      (this.model.scrollBack > 0 ? 1 : 0);
    const maxRows = Math.max(0, paneContentHeight(height) - reservedRows);
    const lines = this.model.visibleTranscript(innerWidth, maxRows, page);
    this.lastLines = lines;
    this.lastMaxRows = maxRows;
    const scrollBack = this.model.scrollBack;
    return paneChrome(
      context,
      this.composedTitle(context),
      Box(
        { flexGrow: 1, flexDirection: "column", justifyContent: "flex-end", overflow: "hidden" },
        ...lines.map((line) => transcriptRow(line, innerWidth, theme)),
      ),
      ...(scrollBack > 0 && !this.model.backtracking()
        ? [
            Text({
              content: `— ↓ ${scrollBack} more · esc returns to live —`,
              fg: theme.textDim,
            }),
          ]
        : []),
      ...queued.map((text) => Text({ content: `⋯ ${text}`, fg: theme.textDim })),
      ...(suggestions.length === 0
        ? []
        : [
            trayBox(
              theme,
              trayRows(suggestions, this.model.selectedSuggestion, innerWidth - 2, theme, {
                namePrefix: "/",
              }),
            ),
          ]),
      ...diffRows,
      ...(ask === undefined ? [] : [askRow(ask.summary, innerWidth, theme)]),
      ...backtrackHint,
      ...prompt.map((line) => Text({ content: line, fg: focused ? theme.text : theme.textDim })),
    );
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

function askRow(summary: string, width: number, theme: Theme) {
  const room = Math.max(0, width - askControls.length - 2);
  const clipped = summary.length > room ? `${summary.slice(0, Math.max(0, room - 1))}…` : summary;
  return Text({ content: `? ${clipped}${askControls}`, fg: theme.accent });
}

function transcriptRow(line: TranscriptLine, width: number, theme: Theme) {
  const stamp = line.stamp ?? "";
  if (line.selected === true) {
    return Text({
      content: `${stamp}${line.text || " "}`.padEnd(width),
      fg: theme.background,
      bg: theme.accent,
    });
  }
  const lead = stamp === "" ? [] : [fg(stampColor(line, theme))(stamp)];
  const bodyWidth = width - Array.from(stamp).length;
  if (line.spans !== undefined) {
    return styledRow(lead, line.spans, line.panel === true, bodyWidth, theme);
  }
  if (lead.length === 0) return Text({ content: line.text || " ", fg: lineColor(line, theme) });
  return Text({
    content: new StyledText([...lead, fg(lineColor(line, theme))(line.text || " ")]),
  });
}

function stampColor(line: TranscriptLine, theme: Theme): string {
  switch (line.kind) {
    case "user":
      return theme.accent;
    case "assistant":
      return theme.textMid;
    case "tool":
      return line.failed ? theme.error : theme.textDim;
    case "error":
      return theme.error;
    case "info":
      return theme.textDim;
  }
}

function styledRow(
  lead: TextChunk[],
  spans: MarkdownSpan[],
  panel: boolean,
  width: number,
  theme: Theme,
) {
  if (lead.length === 0 && spans.length === 0) return Text({ content: " " });
  const chunks = [...lead, ...spans.map((span) => spanChunk(span, theme, panel))];
  if (panel) {
    const filled = spans.reduce((total, span) => total + Array.from(span.text).length, 0);
    if (filled < width) chunks.push(bg(theme.panel)(" ".repeat(width - filled)));
  }
  return Text({ content: new StyledText(chunks) });
}

function spanChunk(span: MarkdownSpan, theme: Theme, panel: boolean): TextChunk {
  let chunk = fg(spanColor(span.tone, theme))(span.text);
  if (span.bold === true) chunk = bold(chunk);
  if (span.italic === true) chunk = italic(chunk);
  if (span.tone === "link") chunk = underline(chunk);
  if (span.tone === "code") chunk = bg(theme.panelLift)(chunk);
  if (panel) chunk = bg(theme.panel)(chunk);
  return chunk;
}

function spanColor(tone: MarkdownTone, theme: Theme): string {
  switch (tone) {
    case "body":
    case "code":
    case "fence":
      return theme.text;
    case "link":
    case "heading":
    case "headingMark":
    case "listMarker":
      return theme.accent;
    case "linkUrl":
      return theme.textMid;
    case "fenceRail":
      return theme.accentSoft;
    case "rule":
    case "fenceTag":
      return theme.textDim;
    case "meta":
      return theme.textMid;
    case "ok":
      return theme.success;
    case "bad":
      return theme.error;
  }
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
    case "tool":
      return line.failed ? theme.error : theme.success;
    case "error":
      return theme.error;
    case "info":
      return theme.textDim;
  }
}
