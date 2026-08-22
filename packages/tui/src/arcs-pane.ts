import { fg, StyledText, Text } from "@opentui/core";
import { type ArcCloseOutcome, type ArcOrdinals, type ArcsPort, arcInk, arcTag } from "./arcs.ts";
import {
  type ArcGroupKey,
  type ArcGroupRow,
  ArcsPaneModel,
  arcGroupLine,
  arcGroupParts,
} from "./arcs-pane-model.ts";
import { type Chord, parseChord } from "./keys.ts";
import type { Pane, PaneContext, PaneDescriptor, PaneIntents, PaneView } from "./pane.ts";
import {
  paneChrome,
  paneContentHeight,
  paneContentWidth,
  paneFailureLine,
  paneTitle,
} from "./pane-chrome.ts";
import { PaneTasks } from "./pane-tasks.ts";
import { PaneTrayModel, paneTrayView, type TrayCommand } from "./pane-tray.ts";
import type { PointerEvent } from "./pointer.ts";
import type { SessionTreePort } from "./session-tree-pane.ts";
import {
  overviewRowLine,
  overviewRowParts,
  type SessionOverviewRow,
  type SessionPresence,
} from "./sessions-overview-model.ts";
import { slugChunks, slugInk } from "./slug.ts";
import { clipChunks, dimLine } from "./text-chunks.ts";
import type { Theme } from "./theme.ts";

export interface ArcsPaneOptions {
  arcs: ArcsPort;
  sessions: Pick<SessionTreePort, "overview" | "attach" | "subscribe">;
  currentSession: () => string | undefined;
  presence?: SessionPresence;
  arcOrdinal?: ArcOrdinals;
  now?: () => number;
  drilled?: ArcGroupKey;
}

const refreshFrameMs = 16;

export class ArcsPane implements Pane {
  readonly model: ArcsPaneModel;
  readonly tray: PaneTrayModel;
  private readonly tasks: PaneTasks;
  private readonly unsubscribes: Array<() => void> = [];
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPageRows = 20;

  constructor(
    readonly id: string,
    notify: () => void,
    private readonly intents: PaneIntents,
    private readonly options: ArcsPaneOptions,
  ) {
    this.tasks = new PaneTasks(notify);
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
    const schedule = (): void => this.scheduleRefresh();
    const sessionsWatch = options.sessions.subscribe?.(schedule);
    const arcsWatch = options.arcs.subscribe?.(schedule);
    if (sessionsWatch !== undefined) this.unsubscribes.push(sessionsWatch);
    if (arcsWatch !== undefined) this.unsubscribes.push(arcsWatch);
    this.refresh();
  }

  dispose(): void {
    this.tasks.dispose();
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  title(): string {
    const drilled = this.model.drilled();
    if (drilled === undefined) {
      const count = this.model.arcCount();
      return paneTitle("arcs", count === 0 ? undefined : arcCountDetail(count));
    }
    const count = this.model.sessions.sessionCount();
    const name = drilled.kind === "arc" ? arcTag(drilled.slug) : "no arc";
    return paneTitle(name, count === 0 ? undefined : sessionCountDetail(count));
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
    return this.model.handleKey(chord, this.lastPageRows);
  }

  handleMouse(local: { x: number; y: number }, event: PointerEvent): boolean {
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
    const { theme, focused, height, width } = context;
    const innerWidth = paneContentWidth(width);
    const nameLine = this.nameLine(theme, focused);
    const tray = this.tray.open ? paneTrayView(this.tray, innerWidth, theme) : undefined;
    this.lastPageRows = Math.max(
      0,
      paneContentHeight(height) - (nameLine === undefined ? 0 : 1) - (tray?.rows ?? 0),
    );
    return paneChrome(
      context,
      this.title(),
      ...this.bodyLines(theme, this.lastPageRows, innerWidth),
      ...(nameLine === undefined ? [] : [nameLine]),
      ...(tray?.children ?? []),
    );
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== undefined || !this.tasks.live()) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh();
    }, refreshFrameMs);
    this.refreshTimer.unref?.();
  }

  private async focusOrOpen(sessionId: string): Promise<void> {
    const paneId = this.options.presence?.paneFor(sessionId);
    if (paneId !== undefined) {
      this.intents.focusPane(paneId);
      return;
    }
    await this.options.sessions.attach?.(sessionId);
    if (this.tasks.live()) this.intents.openSession(sessionId);
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

  private bodyLines(theme: Theme, rows: number, width: number) {
    const failure = this.tasks.failure();
    if (failure !== undefined) return [paneFailureLine(failure, theme, width)];
    if (this.model.level() === "arcs") return this.arcLines(theme, rows, width);
    return this.sessionLines(theme, rows, width);
  }

  private arcLines(theme: Theme, rows: number, width: number) {
    const visible = this.model.visibleRows(rows);
    if (visible.length === 0) {
      return [dimLine("░ no arcs yet · n names one · /arc new binds this session", theme, width)];
    }
    return visible.map(({ index, row }) =>
      this.arcLine(row, index === this.model.cursor, theme, width),
    );
  }

  private arcLine(row: ArcGroupRow, selected: boolean, theme: Theme, width: number) {
    if (selected) {
      const content = arcGroupLine(row, selected).slice(0, width);
      return Text({ content: content.padEnd(width), fg: theme.background, bg: theme.accent });
    }
    const archived = row.status === "archived";
    const ink = archived ? theme.textDim : row.current ? theme.accentSoft : theme.text;
    const { lead, label, facts } = arcGroupParts(row, selected);
    const labelInk = archived ? theme.textDim : this.arcInkFor(row.key, theme);
    const chunks = [fg(ink)(lead), ...slugChunks(label, slugInk(theme, labelInk)), fg(ink)(facts)];
    return Text({ content: new StyledText(clipChunks(chunks, width)) });
  }

  private sessionLines(theme: Theme, rows: number, width: number) {
    const visible = this.model.sessions.visibleRows(rows);
    if (visible.length === 0) return [dimLine("░ no sessions here yet", theme, width)];
    return visible.map(({ index, row }) =>
      this.sessionLine(row, index === this.model.sessions.cursor, theme, width),
    );
  }

  private sessionLine(row: SessionOverviewRow, selected: boolean, theme: Theme, width: number) {
    const untagged = { ...row, arc: undefined };
    if (selected) {
      const content = overviewRowLine(untagged, selected).slice(0, width);
      return Text({ content: content.padEnd(width), fg: theme.background, bg: theme.accent });
    }
    const color = row.current ? theme.accentSoft : theme.text;
    const { lead, title, age, counts } = overviewRowParts(untagged, selected);
    const chunks = [
      fg(color)(lead),
      ...slugChunks(title, slugInk(theme, color)),
      fg(color)(`${age}${counts}`),
    ];
    return Text({ content: new StyledText(clipChunks(chunks, width)) });
  }

  private arcInkFor(key: ArcGroupKey, theme: Theme): string {
    if (key.kind !== "arc") return theme.textDim;
    return arcInk(theme, this.options.arcOrdinal?.(key.slug));
  }

  private trayCommands(): TrayCommand[] {
    const press = (spec: string): TrayCommand["run"] => {
      return () => this.handleKey(parseChord(spec));
    };
    if (this.model.level() === "arcs") {
      return [
        {
          name: "open",
          description: "list this arc's sessions",
          shortcut: "⏎",
          run: press("enter"),
        },
        { name: "new", description: "name a new arc", shortcut: "n", run: press("n") },
        {
          name: "close",
          description: "close the selected arc through the airlock",
          shortcut: "c",
          run: press("c"),
        },
        {
          name: "abandon",
          description: "archive the selected arc without distilling",
          shortcut: "A",
          run: press("shift+a"),
        },
        {
          name: "refresh",
          description: "reload arcs and sessions",
          shortcut: "r",
          run: press("r"),
        },
      ];
    }
    return [
      {
        name: "open",
        description: "open the selected session",
        shortcut: "⏎",
        run: press("enter"),
      },
      {
        name: "back",
        description: "return to the arcs list",
        shortcut: "esc",
        run: press("escape"),
      },
      { name: "refresh", description: "reload arcs and sessions", shortcut: "r", run: press("r") },
    ];
  }

  private nameLine(theme: Theme, focused: boolean) {
    if (!this.model.naming) return undefined;
    const caret = focused ? "▌" : "";
    return Text({ content: `new arc: ${this.model.nameDraft ?? ""}${caret}`, fg: theme.accent });
  }
}

export function describeCloseOutcome(slug: string, outcome: ArcCloseOutcome): string {
  if (outcome.kind === "closed") {
    const released =
      outcome.released === 0
        ? ""
        : ` · ${outcome.released} ${plural(outcome.released, "session")} released`;
    return `arc ${slug} closed · delivered ${outcome.delivered} ${plural(outcome.delivered, "note")}${released}`;
  }
  const pending = [
    `${outcome.candidates} ${plural(outcome.candidates, "note")}`,
    `${outcome.questions} ${plural(outcome.questions, "question")}`,
  ].join(" and ");
  const wedged =
    outcome.wedged === 0
      ? ""
      : ` · ${outcome.wedged} live ${plural(outcome.wedged, "session")} didn't flush`;
  return `arc ${slug} is waiting at the airlock · ${pending} to triage in the memory pane${wedged} · /arc abandon ${slug} archives without distilling`;
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

function arcCountDetail(count: number): string {
  return count === 1 ? "1 arc" : `${count} arcs`;
}

function sessionCountDetail(count: number): string {
  return count === 1 ? "1 session" : `${count} sessions`;
}
