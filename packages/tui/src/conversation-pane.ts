import type { Agent, ToolCallPart } from "@keywork/engine";
import { Box, Text } from "@opentui/core";
import {
  type CommandsPort,
  ConversationModel,
  type Titler,
  type TranscriptLine,
  transcriptLines,
} from "./conversation-model.ts";
import type { Chord } from "./keys.ts";
import type { Pane, PaneContext, PaneView } from "./pane.ts";
import { paneChrome, paneTitle } from "./pane-chrome.ts";
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

  confirmMutation(call: ToolCallPart): Promise<boolean> {
    return this.model.confirmMutation(call);
  }

  async settled(): Promise<void> {
    await this.model.lastSend;
  }

  view(context: PaneContext): PaneView {
    const { theme, focused, width, height } = context;
    const innerWidth = Math.max(10, width - 4);
    const suggestions = focused ? this.model.suggestions() : [];
    const maxRows = Math.max(3, height - 4 - suggestions.length);
    const lines = transcriptLines(this.model.entries, innerWidth).slice(-maxRows);
    const prompt = `› ${this.model.input}${focused ? "▌" : ""}`;
    const ask = this.model.pendingAsk;
    return paneChrome(
      context,
      this.title(),
      Box(
        { flexGrow: 1, flexDirection: "column", justifyContent: "flex-end", overflow: "hidden" },
        ...lines.map((line) => Text({ content: line.text || " ", fg: lineColor(line, theme) })),
      ),
      ...suggestions.map((suggestion, index) =>
        suggestionRow(suggestion, index === this.model.selectedSuggestion, theme),
      ),
      ...(ask === undefined
        ? []
        : [Text({ content: `? ${ask.summary} — y allow · a always · n deny`, fg: theme.accent })]),
      Text({ content: prompt, fg: focused ? theme.text : theme.textDim }),
    );
  }
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
