import { Text } from "@opentui/core";
import type { Chord } from "./keys.ts";
import type { Pane, PaneContext, PaneDescriptor, PaneIntents, PaneView } from "./pane.ts";
import {
  paneChrome,
  paneContentHeight,
  paneContentWidth,
  paneFailureLine,
  paneTitle,
} from "./pane-chrome.ts";
import { PaneTasks } from "./pane-tasks.ts";
import type { PointerEvent } from "./pointer.ts";
import {
  SessionTreeModel,
  type SessionTreeRow,
  type SessionTreeView,
} from "./session-tree-model.ts";
import {
  overviewRowLine,
  type SessionOverviewItem,
  type SessionOverviewRow,
  type SessionPresence,
  SessionsOverviewModel,
} from "./sessions-overview-model.ts";
import type { Theme } from "./theme.ts";

export interface SessionTreePort {
  load(sessionId: string): Promise<SessionTreeView | undefined>;
  setLabel(sessionId: string, entryId: string, label: string | undefined): Promise<void>;
  fork(sessionId: string, entryId: string): Promise<string | undefined>;
  overview?(): Promise<SessionOverviewItem[]>;
  attach?(sessionId: string): Promise<boolean>;
  subscribe?(listener: (sessionId: string) => void): () => void;
}

export interface SessionTreePaneSeams {
  sessionId?: string;
  presence?: SessionPresence;
  now?: () => number;
}

const refreshFrameMs = 16;

type PaneLevel = "overview" | "entries";

export class SessionTreePane implements Pane {
  readonly model: SessionTreeModel;
  readonly overview: SessionsOverviewModel;
  private paneLevel: PaneLevel = "overview";
  private sessionId: string | undefined;
  private readonly presence: SessionPresence | undefined;
  private readonly tasks: PaneTasks;
  private readonly unsubscribe: (() => void) | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPageRows = 20;

  constructor(
    readonly id: string,
    notify: () => void,
    intents: PaneIntents,
    private readonly port: SessionTreePort,
    currentSession: () => string | undefined,
    seams: SessionTreePaneSeams = {},
  ) {
    this.sessionId = seams.sessionId;
    this.presence = seams.presence;
    this.tasks = new PaneTasks(notify);
    this.model = new SessionTreeModel(() => this.tasks.emit(), {
      refresh: () => this.refresh(),
      fork: (entryId) => this.tasks.track(() => this.fork(entryId, intents)),
      setLabel: (entryId, label) => this.tasks.track(() => this.relabel(entryId, label)),
    });
    this.overview = new SessionsOverviewModel(
      () => this.tasks.emit(),
      {
        refresh: () => this.refresh(),
        activate: (sessionId) => this.tasks.track(() => this.focusOrOpen(sessionId, intents)),
        drill: (sessionId) => this.drillInto(sessionId),
      },
      {
        currentSession,
        ...(seams.presence !== undefined && { presence: seams.presence }),
        ...(seams.now !== undefined && { now: seams.now }),
      },
    );
    this.unsubscribe = port.subscribe?.(() => this.scheduleRefresh());
    this.refresh();
  }

  dispose(): void {
    this.tasks.dispose();
    this.unsubscribe?.();
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  level(): PaneLevel {
    return this.paneLevel;
  }

  title(): string {
    if (this.paneLevel === "overview") {
      const count = this.overview.sessionCount();
      return paneTitle("session tree", count === 0 ? undefined : sessionCountDetail(count));
    }
    const count = this.model.entryCount();
    const name = this.model.sessionName() ?? "session tree";
    return paneTitle(name, count === 0 ? undefined : `${count} entries`);
  }

  describe(): PaneDescriptor {
    return {
      kind: "session-tree",
      ...(this.sessionId !== undefined && { sessionId: this.sessionId }),
    };
  }

  handleKey(chord: Chord): boolean {
    if (this.paneLevel === "overview") return this.overview.handleKey(chord, this.lastPageRows);
    if (!this.model.labeling && (chord.name === "escape" || chord.name === "backspace")) {
      return this.returnToOverview();
    }
    return this.model.handleKey(chord, this.lastPageRows);
  }

  handleMouse(local: { x: number; y: number }, event: PointerEvent): boolean {
    if (event.type !== "down" || this.tasks.failure() !== undefined) return false;
    const row = local.y - 1;
    if (row < 0 || row >= this.lastPageRows) return false;
    if (this.paneLevel === "overview") return this.overview.activateVisible(row, this.lastPageRows);
    return this.model.selectVisible(row, this.lastPageRows);
  }

  settled(): Promise<void> {
    return this.tasks.settled();
  }

  refresh(): void {
    const drilled = this.sessionId;
    if (this.paneLevel === "entries" && drilled !== undefined) this.refreshEntries(drilled);
    else this.refreshOverview();
  }

  view(context: PaneContext): PaneView {
    const { theme, focused, height, width } = context;
    const labelLine = this.labelLine(theme, focused);
    this.lastPageRows = Math.max(0, paneContentHeight(height) - (labelLine === undefined ? 0 : 1));
    return paneChrome(
      context,
      this.title(),
      ...this.bodyLines(theme, this.lastPageRows, paneContentWidth(width)),
      ...(labelLine === undefined ? [] : [labelLine]),
    );
  }

  private refreshOverview(): void {
    this.tasks.track(async () => {
      const items = (await this.port.overview?.()) ?? [];
      this.overview.setItems(items);
    });
  }

  private refreshEntries(sessionId: string): void {
    this.tasks.track(() => this.port.load(sessionId).then((view) => this.model.setView(view)));
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== undefined || !this.tasks.live()) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh();
    }, refreshFrameMs);
    this.refreshTimer.unref?.();
  }

  private drillInto(sessionId: string): void {
    this.sessionId = sessionId;
    this.paneLevel = "entries";
    this.refreshEntries(sessionId);
    this.tasks.emit();
  }

  private returnToOverview(): boolean {
    this.paneLevel = "overview";
    this.refreshOverview();
    this.tasks.emit();
    return true;
  }

  private async focusOrOpen(sessionId: string, intents: PaneIntents): Promise<void> {
    const paneId = this.presence?.paneFor(sessionId);
    if (paneId !== undefined) {
      intents.focusPane(paneId);
      return;
    }
    await this.port.attach?.(sessionId);
    if (this.tasks.live()) intents.openSession(sessionId);
  }

  private async fork(entryId: string, intents: PaneIntents): Promise<void> {
    if (this.sessionId === undefined) return;
    const forkedId = await this.port.fork(this.sessionId, entryId);
    if (forkedId !== undefined && this.tasks.live()) intents.openSession(forkedId);
  }

  private async relabel(entryId: string, label: string | undefined): Promise<void> {
    if (this.sessionId === undefined) return;
    await this.port.setLabel(this.sessionId, entryId, label);
    if (!this.tasks.live()) return;
    this.model.setView(await this.port.load(this.sessionId));
  }

  private bodyLines(theme: Theme, rows: number, width: number) {
    const failure = this.tasks.failure();
    if (failure !== undefined) return [paneFailureLine(failure, theme, width)];
    if (this.paneLevel === "overview") return this.overviewLines(theme, rows, width);
    return this.entryLines(theme, rows, width);
  }

  private overviewLines(theme: Theme, rows: number, width: number) {
    const visible = this.overview.visibleRows(rows);
    if (visible.length === 0) return [dimLine("░ no sessions yet", theme, width)];
    return visible.map(({ index, row }) =>
      this.overviewLine(row, index === this.overview.cursor, theme, width),
    );
  }

  private overviewLine(row: SessionOverviewRow, selected: boolean, theme: Theme, width: number) {
    const content = overviewRowLine(row, selected).slice(0, width);
    if (selected) {
      return Text({ content: content.padEnd(width), fg: theme.background, bg: theme.accent });
    }
    return Text({ content, fg: row.current ? theme.accentSoft : theme.text });
  }

  private entryLines(theme: Theme, rows: number, width: number) {
    if (this.model.sessionId() === undefined) {
      return [dimLine("loading session…", theme, width)];
    }
    const visible = this.model.visibleRows(rows);
    if (visible.length === 0) return [dimLine("empty session", theme, width)];
    return visible.map(({ index, row }) =>
      this.entryLine(row, index === this.model.cursor, theme, width),
    );
  }

  private entryLine(row: SessionTreeRow, selected: boolean, theme: Theme, width: number) {
    const content = entryRowText(row).slice(0, width);
    if (selected) {
      return Text({ content: content.padEnd(width), fg: theme.background, bg: theme.accent });
    }
    return Text({ content, fg: row.onActivePath ? theme.accentSoft : theme.text });
  }

  private labelLine(theme: Theme, focused: boolean) {
    if (!this.model.labeling) return undefined;
    const caret = focused ? "▌" : "";
    return Text({ content: `label: ${this.model.labelDraft ?? ""}${caret}`, fg: theme.accent });
  }
}

function sessionCountDetail(count: number): string {
  return count === 1 ? "1 session" : `${count} sessions`;
}

function dimLine(text: string, theme: Theme, width: number) {
  return Text({ content: [...text].slice(0, width).join(""), fg: theme.textDim });
}

function entryRowText(row: SessionTreeRow): string {
  const indent = "  ".repeat(row.depth);
  const affordance = row.collapsed ? "▸ " : row.branchPoint ? "▾ " : "  ";
  const marker = row.onActivePath ? "●" : "○";
  const label = row.label === undefined ? "" : ` [${row.label}]`;
  return `${indent}${affordance}${marker} ${row.text}${label}`;
}
