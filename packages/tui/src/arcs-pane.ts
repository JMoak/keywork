import { fg, StyledText, Text } from "@opentui/core";
import { type ArcOrdinals, type ArcsPort, arcInk, arcTag, describeCloseOutcome } from "./arcs.ts";
import {
  type ArcGroupKey,
  type ArcGroupRow,
  ArcsPaneModel,
  arcGroupLine,
  arcGroupParts,
} from "./arcs-pane-model.ts";
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
  paneTitle,
  rowsView,
  trayCommandsPressing,
} from "./pane-chrome.ts";
import { PaneTasks } from "./pane-tasks.ts";
import { PaneTrayModel, paneTrayMouse, paneTrayView, type TrayCommand } from "./pane-tray.ts";
import { pluralize } from "./pluralize.ts";
import type { PointerEvent } from "./pointer.ts";
import { focusOrOpenSession, overviewRowView, type SessionTreePort } from "./session-tree-pane.ts";
import { overviewRowLine, type SessionPresence } from "./sessions-overview-model.ts";
import { slugChunks, slugInk } from "./slug-ink.ts";
import type { Theme } from "./theme.ts";
import { clipSpans } from "./width.ts";

export interface ArcsPaneOptions {
  arcs: ArcsPort;
  sessions: Pick<SessionTreePort, "overview" | "attach" | "subscribe">;
  currentSession: () => string | undefined;
  presence?: SessionPresence;
  arcOrdinal?: ArcOrdinals;
  now?: () => number;
  drilled?: ArcGroupKey;
  scheduleFrame?: FrameScheduler;
}

export class ArcsPane implements Pane {
  readonly model: ArcsPaneModel;
  readonly tray: PaneTrayModel;
  private readonly tasks: PaneTasks;
  private readonly unsubscribes: Array<() => void> = [];
  private readonly pendingRefresh: FrameCoalescer;
  private lastPageRows = 20;
  private trayFirstRow = 0;

  constructor(
    readonly id: string,
    notify: () => void,
    private readonly intents: PaneIntents,
    private readonly options: ArcsPaneOptions,
  ) {
    this.tasks = new PaneTasks(notify);
    this.pendingRefresh = new FrameCoalescer(options.scheduleFrame ?? nextFrame, () =>
      this.refresh(),
    );
    this.model = new ArcsPaneModel(
      () => this.tasks.emit(),
      {
        refresh: () => this.refresh(),
        activate: (sessionId) => this.tasks.track(() => this.focusOrOpen(sessionId)),
        create: (slug) => this.tasks.track(() => this.create(slug)),
        close: (slug) => this.tasks.track(() => this.close(slug)),
        abandon: (slug) => this.tasks.track(() => this.abandon(slug)),
        reject: (reason) => intents.notice?.(reason),
      },
      {
        currentSession: options.currentSession,
        ...(options.presence !== undefined && { presence: options.presence }),
        ...(options.now !== undefined && { now: options.now }),
        ...(options.drilled !== undefined && { drilled: options.drilled }),
      },
    );
    this.tray = new PaneTrayModel(
      () => this.tasks.emit(),
      () => this.trayCommands(),
    );
    const schedule = (): void => this.pendingRefresh.request();
    const sessionsWatch = options.sessions.subscribe?.(schedule);
    const arcsWatch = options.arcs.subscribe?.(schedule);
    if (sessionsWatch !== undefined) this.unsubscribes.push(sessionsWatch);
    if (arcsWatch !== undefined) this.unsubscribes.push(arcsWatch);
    this.refresh();
  }

  dispose(): void {
    this.tasks.dispose();
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.pendingRefresh.dispose();
  }

  title(): string {
    const drilled = this.model.drilled();
    if (drilled === undefined) {
      const count = this.model.arcCount();
      return paneTitle("arcs", count === 0 ? undefined : pluralize(count, "arc"));
    }
    const count = this.model.sessions.sessionCount();
    const name = drilled.kind === "arc" ? arcTag(drilled.slug) : "no arc";
    return paneTitle(name, count === 0 ? undefined : pluralize(count, "session"));
  }

  describe(): PaneDescriptor {
    const drilled = this.model.drilled();
    return {
      kind: "arcs",
      ...(drilled?.kind === "arc" && { arc: drilled.slug }),
    };
  }

  handleKey(chord: Chord, sequence?: string): boolean {
    if (this.tray.open) return this.tray.handleKey(chord, sequence);
    if (!this.model.naming && this.tray.opensOn(chord)) {
      this.tray.openTray();
      return true;
    }
    return this.model.handleKey(chord, this.lastPageRows, sequence);
  }

  handleMouse(local: { x: number; y: number }, event: PointerEvent): boolean {
    if (this.tray.open) return paneTrayMouse(this.tray, this.trayFirstRow, local, event);
    if (event.type !== "down" || this.tasks.failure() !== undefined) return false;
    const row = local.y - 1;
    if (row < 0 || row >= this.lastPageRows) return false;
    if (this.model.level() === "arcs") return this.model.selectVisible(row, this.lastPageRows);
    return this.model.sessions.activateVisible(row, this.lastPageRows);
  }

  settled(): Promise<void> {
    return this.tasks.settled();
  }

  refresh(): void {
    this.tasks.track(async () => {
      const [arcs, items] = await Promise.all([
        this.options.arcs.list(),
        this.options.sessions.overview?.() ?? Promise.resolve([]),
      ]);
      this.model.setInputs(arcs, items);
    });
  }

  view(context: PaneContext): PaneView {
    const { theme, focused } = context;
    const innerWidth = paneContentWidth(context);
    const nameLine = this.nameLine(theme, focused);
    const tray = this.tray.open
      ? paneTrayView(this.tray, innerWidth, theme, context.glyphs)
      : undefined;
    this.lastPageRows = Math.max(
      0,
      paneContentHeight(context) - (nameLine === undefined ? 0 : 1) - (tray?.rows ?? 0),
    );
    const body = this.bodyLines(theme, this.lastPageRows, innerWidth);
    this.trayFirstRow = 2 + body.length + (nameLine === undefined ? 0 : 1);
    return paneChrome(
      context,
      this.title(),
      ...body,
      ...(nameLine === undefined ? [] : [nameLine]),
      ...(tray?.children ?? []),
    );
  }

  private focusOrOpen(sessionId: string): Promise<void> {
    return focusOrOpenSession(sessionId, {
      sessions: this.options.sessions,
      intents: this.intents,
      live: () => this.tasks.live(),
      ...(this.options.presence !== undefined && { presence: this.options.presence }),
    });
  }

  private async create(slug: string): Promise<void> {
    const created = await this.options.arcs.create(slug);
    this.intents.notice?.(`arc ${created.slug} created · /arc ${created.slug} binds a session`);
    this.refresh();
  }

  private async close(slug: string): Promise<void> {
    const outcome = await this.options.arcs.close(slug);
    this.intents.notice?.(describeCloseOutcome(slug, outcome));
    this.refresh();
  }

  private async abandon(slug: string): Promise<void> {
    await this.options.arcs.abandon(slug);
    this.intents.notice?.(`arc ${slug} abandoned · archived without distilling, nothing deleted`);
    this.refresh();
  }

  private bodyLines(theme: Theme, rows: number, width: number): PaneChild[] {
    const failure = this.tasks.failure();
    if (failure !== undefined) return [paneFailureLine(failure, theme, width)];
    if (this.model.level() === "arcs") {
      return rowsView(this.model, rows, theme, width, {
        empty: "░ no arcs yet · n names one · /arc new binds this session",
        text: (row) => arcGroupLine(row, true),
        line: (row) => this.arcLine(row, theme, width),
      });
    }
    return rowsView(this.model.sessions, rows, theme, width, {
      empty: "░ no sessions here yet",
      text: (row) => overviewRowLine({ ...row, arc: undefined }, true),
      line: (row) => overviewRowView({ ...row, arc: undefined }, theme, width, () => theme.textDim),
    });
  }

  private arcLine(row: ArcGroupRow, theme: Theme, width: number): PaneChild {
    const archived = row.status === "archived";
    const ink = archived ? theme.textDim : row.current ? theme.accentSoft : theme.text;
    const { lead, label, facts } = arcGroupParts(row, false);
    const labelInk = archived ? theme.textDim : this.arcInkFor(row.key, theme);
    const chunks = [fg(ink)(lead), ...slugChunks(label, slugInk(theme, labelInk)), fg(ink)(facts)];
    return Text({ content: new StyledText(clipSpans(chunks, width)) });
  }

  private arcInkFor(key: ArcGroupKey, theme: Theme): string {
    return arcInk(theme, key.kind === "arc" ? this.options.arcOrdinal?.(key.slug) : undefined);
  }

  private trayCommands(): TrayCommand[] {
    const table = this.model.level() === "arcs" ? arcsTray : arcSessionsTray;
    return trayCommandsPressing((chord) => this.handleKey(chord), table);
  }

  private nameLine(theme: Theme, focused: boolean) {
    if (!this.model.naming) return undefined;
    const caret = focused ? "▌" : "";
    return Text({ content: `new arc: ${this.model.nameDraft ?? ""}${caret}`, fg: theme.accent });
  }
}

export const arcsTray: readonly KeyedTrayCommand[] = [
  { name: "open", description: "list this arc's sessions", key: "enter" },
  { name: "new", description: "name a new arc", key: "n" },
  { name: "close", description: "close the selected arc through the airlock", key: "c" },
  { name: "abandon", description: "archive the selected arc without distilling", key: "shift+a" },
  { name: "refresh", description: "reload arcs and sessions", key: "r" },
];

export const arcSessionsTray: readonly KeyedTrayCommand[] = [
  { name: "open", description: "open the selected session", key: "enter" },
  { name: "back", description: "return to the arcs list", key: "escape" },
  { name: "refresh", description: "reload arcs and sessions", key: "r" },
];
