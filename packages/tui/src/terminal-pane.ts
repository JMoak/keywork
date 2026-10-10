import type { PtySupport } from "@keywork/engine";
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
  chooseTerminalBackend,
  type PipeBackend,
  type PtyBackend,
  pipeBackend,
  type TerminalBackend,
} from "./terminal-backend.ts";
import {
  type MirrorSource,
  type MirrorTarget,
  type TerminalLine,
  TerminalModel,
  type TerminalSpawner,
  type TerminalTone,
} from "./terminal-model.ts";
import { PtyShell } from "./terminal-shell.ts";
import type { TerminalSurfaceFactory } from "./terminal-surface.ts";
import type { Theme } from "./theme.ts";

export interface TerminalPaneOptions {
  cwd?: string;
  backend?: TerminalBackend;
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
  pty?: PtySupport;
  surfaces?: TerminalSurfaceFactory;
}

export interface TerminalPanePort {
  trusted: boolean;
  spawn?: TerminalSpawner;
  pty?: PtySupport;
}

export const untrustedShellNotice = "shell mode needs a trusted workspace · /init to trust it";
export const noPtyProbeReason = "no PTY probe wired; running the pipe shell";

export function terminalPaneFactory(deps: TerminalPaneDeps): TerminalPaneFactory {
  return (id, notify, mode, target, intents) => {
    if (mode === "shell" && !deps.trusted()) {
      intents.notice?.(untrustedShellNotice);
      return undefined;
    }
    return new TerminalPane(id, mode, notify, {
      cwd: deps.cwd,
      backend: chooseTerminalBackend({
        pty: deps.pty ?? { available: false, reason: noPtyProbeReason },
        surfaces: deps.surfaces,
        spawn: deps.spawn,
      }),
      mirror: deps.mirror,
      target,
    });
  };
}

export class TerminalPane implements Pane {
  readonly model: TerminalModel | undefined;
  readonly shell: PtyShell | undefined;
  readonly mode: TerminalMode;
  private readonly sessionTarget: () => string | undefined;
  private lastPageRows = 20;

  constructor(
    readonly id: string,
    mode: TerminalMode,
    notify: () => void,
    options: TerminalPaneOptions = {},
  ) {
    this.mode = mode;
    const backend = shellBackendOf(mode, options);
    if (backend?.kind === "pty") {
      this.shell = new PtyShell({ cwd: options.cwd ?? ".", backend, notify });
      this.sessionTarget = () => undefined;
      return;
    }
    const model = new TerminalModel({
      mode,
      notify,
      ...(options.cwd !== undefined && { cwd: options.cwd }),
      ...(backend !== undefined && { spawn: backend.spawn }),
      ...(backend !== undefined &&
        backend.reason !== "" && { banner: `· pipes: ${backend.reason}` }),
      ...(options.mirror !== undefined && { mirror: options.mirror }),
      ...(options.target !== undefined && { target: options.target }),
      ...(options.scrollbackLimit !== undefined && { scrollbackLimit: options.scrollbackLimit }),
    });
    this.model = model;
    this.sessionTarget = () => model.sessionId;
  }

  title(): string {
    if (this.shell !== undefined) return paneTitle("terminal", this.shell.status());
    const status = this.model?.status() ?? "";
    return paneTitle("terminal", this.mode === "shell" ? `${status} · pipes` : status);
  }

  describe(): PaneDescriptor {
    const sessionId = this.sessionTarget();
    return {
      kind: "terminal",
      mode: this.mode,
      ...(sessionId !== undefined && { sessionId }),
    };
  }

  handleKey(chord: Chord, sequence?: string): boolean {
    if (this.shell !== undefined) return this.shell.handleKey(chord, sequence);
    return this.model?.handleKey(chord, this.lastPageRows, sequence) ?? false;
  }

  handlePaste(text: string): boolean {
    return this.shell?.handlePaste(text) ?? false;
  }

  dispose(): void {
    this.shell?.dispose();
    this.model?.dispose();
  }

  view(context: PaneContext): PaneView {
    if (this.shell !== undefined) return this.ptyView(context, this.shell);
    const { theme } = context;
    const width = paneContentWidth(context);
    const promptRows = this.mode === "shell" ? 1 : 0;
    this.lastPageRows = Math.max(0, paneContentHeight(context) - promptRows);
    return paneChrome(
      context,
      this.title(),
      ...this.bodyLines(theme, this.lastPageRows, width),
      ...(promptRows === 0 ? [] : [this.promptLine(theme, context.focused, width)]),
    );
  }

  private ptyView(context: PaneContext, shell: PtyShell): PaneView {
    shell.resize({
      cols: Math.max(1, paneContentWidth(context)),
      rows: Math.max(1, paneContentHeight(context)),
    });
    shell.focusChanged(context.focused);
    return paneChrome(context, this.title(), shell.view());
  }

  private bodyLines(theme: Theme, rows: number, width: number): PaneChild[] {
    const lines = this.model?.visibleLines(rows, width) ?? [];
    if (lines.length === 0) return [paneLine(emptyText(this.mode), theme.textDim, width)];
    return lines.map((line) => paneLine(line.text, inkOf(line, theme), width));
  }

  private promptLine(theme: Theme, focused: boolean, width: number): PaneChild {
    const caret = focused ? "▌" : "";
    return paneLine(`❯ ${this.model?.input ?? ""}${caret}`, theme.accent, width);
  }
}

function shellBackendOf(
  mode: TerminalMode,
  options: TerminalPaneOptions,
): PtyBackend | PipeBackend | undefined {
  if (mode !== "shell") return undefined;
  if (options.backend !== undefined) return options.backend;
  return options.spawn === undefined ? undefined : pipeBackend("", options.spawn);
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
