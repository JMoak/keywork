import type { Agent, ToolCallPart } from "@keywork/engine";
import { Box, Text } from "@opentui/core";
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
import type { Pane, PaneContext, PaneDescriptor, PaneView } from "./pane.ts";
import { paneChrome, paneContentHeight, paneContentWidth, paneTitle } from "./pane-chrome.ts";
import { type PointerEvent, wheelSteps } from "./pointer.ts";
import type { Theme } from "./theme.ts";
import { trayBox, trayRows } from "./tray.ts";

const askDiffRows = 10;

export interface ConversationPaneOptions {
  ports?: ConversationPorts;
  initialDraft?: string;
}

export class ConversationPane implements Pane {
  sessionId: string | undefined;
  private readonly model: ConversationModel;
  private closed = false;

  constructor(
    readonly id: string,
    agent: Agent | undefined,
    notify: () => void,
    titler?: Titler,
    commands?: CommandsPort,
    options?: ConversationPaneOptions,
  ) {
    this.model = new ConversationModel(agent, notify, titler, commands, options?.ports);
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

  handleMouse(_local: { x: number; y: number }, event: PointerEvent): boolean {
    if (event.type !== "scroll" || event.scroll === undefined) return false;
    const steps = wheelSteps(event.scroll.delta);
    return this.model.scrollBy(event.scroll.direction === "up" ? steps : -steps);
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

  view(context: PaneContext): PaneView {
    const { theme, focused, width, height } = context;
    const innerWidth = paneContentWidth(width);
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
    const lines = this.model.visibleTranscript(innerWidth, maxRows);
    const scrollBack = this.model.scrollBack;
    return paneChrome(
      context,
      this.title(),
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
  if (line.selected === true) {
    return Text({
      content: (line.text || " ").padEnd(width),
      fg: theme.background,
      bg: theme.accent,
    });
  }
  return Text({ content: line.text || " ", fg: lineColor(line, theme) });
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
    case "tail":
      return theme.textDim;
    case "error":
      return theme.error;
    case "info":
      return theme.textDim;
  }
}
