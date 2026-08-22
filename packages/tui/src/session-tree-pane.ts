import { fg, StyledText, Text } from "@opentui/core";
import { type ArcOrdinals, arcInk } from "./arcs.ts";
import { FrameCoalescer, type FrameScheduler, nextFrame } from "./frame-scheduler.ts";
import type { Chord } from "./keys.ts";
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
  trayCommandsPressing,
} from "./pane-chrome.ts";
import { PaneTasks } from "./pane-tasks.ts";
import { PaneTrayModel, paneTrayView, type TrayCommand } from "./pane-tray.ts";
import { pluralize } from "./pluralize.ts";
import type { PointerEvent } from "./pointer.ts";
import {
  SessionTreeModel,
  type SessionTreeRow,
  type SessionTreeView,
} from "./session-tree-model.ts";
import {
  overviewRowLine,
  overviewRowParts,
  type SessionOverviewItem,
  type SessionOverviewRow,
  type SessionPresence,
  SessionsOverviewModel,
} from "./sessions-overview-model.ts";
import { slugChunks, slugInk } from "./slug.ts";
import type { Theme } from "./theme.ts";
import { clipSpans } from "./width.ts";

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
  arcOrdinal?: ArcOrdinals;
  scheduleFrame?: FrameScheduler;
}

type PaneLevel = "overview" | "entries";

export class SessionTreePane implements Pane {
  readonly model: SessionTreeModel;
  readonly overview: SessionsOverviewModel;
  readonly tray: PaneTrayModel;
  private paneLevel: PaneLevel = "overview";
  private sessionId: string | undefined;
  private readonly presence: SessionPresence | undefined;
  private readonly arcOrdinal: ArcOrdinals | undefined;
  private readonly tasks: PaneTasks;
  private readonly unsubscribe: (() => void) | undefined;
  private readonly pendingRefresh: FrameCoalescer;
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
    this.arcOrdinal = seams.arcOrdinal;
    this.tasks = new PaneTasks(notify);
    this.pendingRefresh = new FrameCoalescer(seams.scheduleFrame ?? nextFrame, () =>
      this.refresh(),
    );
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
    this.tray = new PaneTrayModel(
      () => this.tasks.emit(),
      () => this.trayCommands(),
    );
    this.unsubscribe = port.subscribe?.(() => this.pendingRefresh.request());
    this.refresh();
  }

  dispose(): void {
    this.tasks.dispose();
    this.unsubscribe?.();
    this.pendingRefresh.dispose();
  }

  level(): PaneLevel {
    return this.paneLevel;
  }

  title(): string {
    if (this.paneLevel === "overview") {
      const count = this.overview.sessionCount();
      return paneTitle("session tree", count === 0 ? undefined : pluralize(count, "session"));
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

  handleKey(chord: Chord, sequence?: string): boolean {
    if (this.tray.open) return this.tray.handleKey(chord, sequence);
    if (!this.model.labeling && this.tray.opensOn(chord)) {
      this.tray.openTray();
      return true;
    }
    if (this.paneLevel === "overview") return this.overview.handleKey(chord, this.lastPageRows);
    if (!this.model.labeling && (chord.name === "escape" || chord.name === "backspace")) {
      return this.returnToOverview();
    }
    return this.model.handleKey(chord, this.lastPageRows, sequence);
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
    const innerWidth = paneContentWidth(width);
    const labelLine = this.labelLine(theme, focused);
    const tray = this.tray.open ? paneTrayView(this.tray, innerWidth, theme) : undefined;
    this.lastPageRows = Math.max(
      0,
      paneContentHeight(height) - (labelLine === undefined ? 0 : 1) - (tray?.rows ?? 0),
    );
    return paneChrome(
      context,
      this.title(),
      ...this.bodyLines(theme, this.lastPageRows, innerWidth),
      ...(labelLine === undefined ? [] : [labelLine]),
      ...(tray?.children ?? []),
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
    const attached = (await this.port.attach?.(sessionId)) ?? true;
    if (attached && this.tasks.live()) intents.openSession(sessionId);
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

  private bodyLines(theme: Theme, rows: number, width: number): PaneChild[] {
    const failure = this.tasks.failure();
    if (failure !== undefined) return [paneFailureLine(failure, theme, width)];
    if (this.paneLevel === "overview") {
      return rowsView(this.overview, rows, theme, width, {
        empty: "░ no sessions yet",
        text: (row) => overviewRowLine(row, true),
        line: (row) => overviewRowView(row, theme, width, this.arcInkOf(theme)),
      });
    }
    if (this.model.sessionId() === undefined) {
      return [paneLine("loading session…", theme.textDim, width)];
    }
    return rowsView(this.model, rows, theme, width, {
      empty: "empty session",
      text: entryRowText,
      line: (row) =>
        paneLine(entryRowText(row), row.onActivePath ? theme.accentSoft : theme.text, width),
    });
  }

  private arcInkOf(theme: Theme): (slug: string) => string {
    return (slug) => arcInk(theme, this.arcOrdinal?.(slug));
  }

  private trayCommands(): TrayCommand[] {
    const table = this.paneLevel === "overview" ? overviewTray : entriesTray;
    return trayCommandsPressing((chord) => this.handleKey(chord), table);
  }

  private labelLine(theme: Theme, focused: boolean) {
    if (!this.model.labeling) return undefined;
    const caret = focused ? "▌" : "";
    return Text({ content: `label: ${this.model.labelDraft ?? ""}${caret}`, fg: theme.accent });
  }
}

export function overviewRowView(
  row: SessionOverviewRow,
  theme: Theme,
  width: number,
  arcInkOf: (slug: string) => string,
): PaneChild {
  const color = row.current ? theme.accentSoft : theme.text;
  const { lead, title, age, arcTag, counts } = overviewRowParts(row, false);
  const chunks = [
    fg(color)(lead),
    ...slugChunks(title, slugInk(theme, color)),
    fg(color)(age),
    ...(arcTag === undefined || row.arc === undefined ? [] : [fg(arcInkOf(row.arc))(arcTag)]),
    fg(color)(counts),
  ];
  return Text({ content: new StyledText(clipSpans(chunks, width)) });
}

const overviewTray: readonly KeyedTrayCommand[] = [
  { name: "open", description: "open the selected session", key: "enter" },
  { name: "entries", description: "browse the selected session's entries", key: "l" },
  { name: "refresh", description: "reload the sessions list", key: "r" },
];

const entriesTray: readonly KeyedTrayCommand[] = [
  { name: "fork", description: "fork at the selected entry", key: "f" },
  { name: "label", description: "label the selected entry", key: "shift+l" },
  { name: "toggle", description: "collapse or expand the selected entry", key: "enter" },
  { name: "back", description: "return to the sessions overview", key: "escape" },
  { name: "refresh", description: "reload this session", key: "r" },
];

function entryRowText(row: SessionTreeRow): string {
  const indent = "  ".repeat(row.depth);
  const affordance = row.collapsed ? "▸ " : row.branchPoint ? "▾ " : "  ";
  const marker = row.onActivePath ? "●" : "○";
  const label = row.label === undefined ? "" : ` [${row.label}]`;
  return `${indent}${affordance}${marker} ${row.text}${label}`;
}
