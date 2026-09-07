import { ConversationPane } from "./conversation-pane.ts";
import type { Chord } from "./keys.ts";
import type { Pane, PaneContext, PaneDescriptor, PaneView, TerminalMode } from "./pane.ts";
import {
  type PaneChild,
  paneChrome,
  paneContentHeight,
  paneContentWidth,
  paneLine,
  paneTitle,
} from "./pane-chrome.ts";
import type { TerminalPaneFactory } from "./pane-kinds.ts";
import {
  type MirrorSource,
  type MirrorTarget,
  type TerminalLine,
  TerminalModel,
  type TerminalSpawner,
  type TerminalTone,
} from "./terminal-model.ts";
import type { Theme } from "./theme.ts";

export interface TerminalPaneOptions {
  cwd?: string;
  spawn?: TerminalSpawner;
  mirror?: MirrorSource;
  target?: MirrorTarget;
  scrollbackLimit?: number;
}

export interface TerminalPaneDeps {
  cwd: string;
  trusted: () => boolean;
  spawn: TerminalSpawner;
  mirror: MirrorSource;
}

export const untrustedShellNotice = "shell mode needs a trusted workspace · /init to trust it";

export function terminalPaneFactory(deps: TerminalPaneDeps): TerminalPaneFactory {
  return (id, notify, mode, target, intents) => {
    if (mode === "shell" && !deps.trusted()) {
      intents.notice?.(untrustedShellNotice);
      return undefined;
    }
    return new TerminalPane(id, mode, notify, {
      cwd: deps.cwd,
      spawn: deps.spawn,
      mirror: deps.mirror,
      target,
    });
  };
}

export class TerminalPane implements Pane {
  readonly model: TerminalModel;
  private lastPageRows = 20;

  constructor(
    readonly id: string,
    mode: TerminalMode,
    notify: () => void,
    options: TerminalPaneOptions = {},
  ) {
    this.model = new TerminalModel({ mode, notify, ...options });
  }

  title(): string {
    return paneTitle("terminal", this.model.status());
  }

  describe(): PaneDescriptor {
    const sessionId = this.model.sessionId;
    return {
      kind: "terminal",
      mode: this.model.mode,
      ...(sessionId !== undefined && { sessionId }),
    };
  }

  handleKey(chord: Chord, sequence?: string): boolean {
    return this.model.handleKey(chord, this.lastPageRows, sequence);
  }

  dispose(): void {
    this.model.dispose();
  }

  view(context: PaneContext): PaneView {
    const { theme, focused } = context;
    const width = paneContentWidth(context);
    const promptRows = this.model.mode === "shell" ? 1 : 0;
    this.lastPageRows = Math.max(0, paneContentHeight(context) - promptRows);
    return paneChrome(
      context,
      this.title(),
      ...this.bodyLines(theme, this.lastPageRows, width),
      ...(promptRows === 0 ? [] : [this.promptLine(theme, focused, width)]),
    );
  }

  private bodyLines(theme: Theme, rows: number, width: number): PaneChild[] {
    const lines = this.model.visibleLines(rows, width);
    if (lines.length === 0) return [paneLine(emptyText(this.model.mode), theme.textDim, width)];
    return lines.map((line) => paneLine(line.text, inkOf(line, theme), width));
  }

  private promptLine(theme: Theme, focused: boolean, width: number): PaneChild {
    const caret = focused ? "▌" : "";
    return paneLine(`❯ ${this.model.input}${caret}`, theme.accent, width);
  }
}

function emptyText(mode: TerminalMode): string {
  return mode === "mirror" ? "agent shell commands appear here" : "type a command and press enter";
}

function inkOf(line: TerminalLine, theme: Theme): string {
  return inks(theme)[line.tone];
}

function inks(theme: Theme): Record<TerminalTone, string> {
  return {
    command: theme.accent,
    input: theme.accentSoft,
    output: theme.text,
    marker: theme.textDim,
    failure: theme.error,
  };
}

export interface TerminalPanePort {
  trusted: boolean;
  spawn?: TerminalSpawner;
}

export function mirrorSourceOverPanes(panes: () => ReadonlyMap<string, Pane>): MirrorSource {
  return {
    locate: (target) => {
      const pane = conversationPaneFor(panes(), target);
      const bus = pane?.currentAgent()?.bus;
      if (pane === undefined || bus === undefined) return undefined;
      const sessionId = pane.sessionId;
      return { bus, ...(sessionId !== undefined && { sessionId }) };
    },
  };
}

function conversationPaneFor(
  panes: ReadonlyMap<string, Pane>,
  target: MirrorTarget,
): ConversationPane | undefined {
  if (target.paneId !== undefined) {
    const pane = panes.get(target.paneId);
    return pane instanceof ConversationPane ? pane : undefined;
  }
  if (target.sessionId === undefined) return undefined;
  for (const pane of panes.values()) {
    if (pane instanceof ConversationPane && pane.sessionId === target.sessionId) return pane;
  }
  return undefined;
}
