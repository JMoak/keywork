import type { Agent, ToolCallPart } from "@keywork/engine";
import { Box, Text } from "@opentui/core";
import {
  type CommandsPort,
  ConversationModel,
  type Titler,
  type TranscriptLine,
} from "./conversation-model.ts";
import type { InputBuffer } from "./input-buffer.ts";
import type { Chord } from "./keys.ts";
import type { Pane, PaneContext, PaneView } from "./pane.ts";
import { paneChrome, paneTitle } from "./pane-chrome.ts";
import { type PointerEvent, wheelSteps } from "./pointer.ts";
import type { Theme } from "./theme.ts";

export class ConversationPane implements Pane {
  private readonly model: ConversationModel;

  constructor(
    readonly id: string,
    agent: Agent | undefined,
    notify: () => void,
    titler?: Titler,
    commands?: CommandsPort,
  ) {
    this.model = new ConversationModel(agent, notify, titler, commands);
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

  handleMouse(_local: { x: number; y: number }, event: PointerEvent): boolean {
    if (event.type !== "scroll" || event.scroll === undefined) return false;
    const steps = wheelSteps(event.scroll.delta);
    return this.model.scrollBy(event.scroll.direction === "up" ? steps : -steps);
  }

  confirmMutation(call: ToolCallPart): Promise<boolean> {
    return this.model.confirmMutation(call);
  }

  dispose(): void {
    this.model.dispose();
  }

  async settled(): Promise<void> {
    let awaited: Promise<unknown>;
    do {
      awaited = this.model.lastSend;
      await awaited;
    } while (awaited !== this.model.lastSend);
  }

  view(context: PaneContext): PaneView {
    const { theme, focused, width, height } = context;
    const innerWidth = Math.max(10, width - 4);
    const suggestions = focused ? this.model.suggestions() : [];
    const prompt = promptLines(this.model.buffer, focused);
    const queued = this.model.queued();
    const ask = this.model.pendingAsk;
    const reservedRows =
      suggestions.length +
      prompt.length +
      queued.length +
      (ask === undefined ? 0 : 1) +
      (this.model.scrollBack > 0 ? 1 : 0);
    const maxRows = Math.max(3, height - 3 - reservedRows);
    const lines = this.model.visibleTranscript(innerWidth, maxRows);
    const scrollBack = this.model.scrollBack;
    return paneChrome(
      context,
      this.title(),
      Box(
        { flexGrow: 1, flexDirection: "column", justifyContent: "flex-end", overflow: "hidden" },
        ...lines.map((line) => Text({ content: line.text || " ", fg: lineColor(line, theme) })),
      ),
      ...(scrollBack > 0
        ? [
            Text({
              content: `— ↓ ${scrollBack} more · esc returns to live —`,
              fg: theme.textDim,
            }),
          ]
        : []),
      ...queued.map((text) => Text({ content: `⋯ ${text}`, fg: theme.textDim })),
      ...suggestions.map((suggestion, index) =>
        suggestionRow(suggestion, index === this.model.selectedSuggestion, theme),
      ),
      ...(ask === undefined
        ? []
        : [Text({ content: `? ${ask.summary} — y allow · a always · n deny`, fg: theme.accent })]),
      ...prompt.map((line) => Text({ content: line, fg: focused ? theme.text : theme.textDim })),
    );
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

function suggestionRow(
  suggestion: { name: string; description: string; shortcut?: string },
  selected: boolean,
  theme: Theme,
) {
  const marker = selected ? "▸" : " ";
  const shortcut = suggestion.shortcut === undefined ? "" : `  ${suggestion.shortcut}`;
  return Text({
    content: `${marker} /${suggestion.name} — ${suggestion.description}${shortcut}`,
    fg: selected ? theme.accent : theme.textDim,
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
