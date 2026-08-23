import { fg, StyledText, Text } from "@opentui/core";
import { arcTag } from "./arcs.ts";
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
import { PaneTrayModel, paneTrayView, type TrayCommand } from "./pane-tray.ts";
import { pluralize } from "./pluralize.ts";
import type { PointerEvent } from "./pointer.ts";
import { focusOrOpenSession, type SessionTreePort } from "./session-tree-pane.ts";
import {
  livenessMark,
  type SessionLiveness,
  type SessionOverviewRow,
  type SessionPresence,
  SessionsOverviewModel,
} from "./sessions-overview-model.ts";
import { slugChunks, slugInk } from "./slug.ts";
import type { Theme } from "./theme.ts";
import { clipSpans } from "./width.ts";

export interface ArcPaneOptions {
  slug: string;
  sessions: Pick<SessionTreePort, "overview" | "attach" | "subscribe">;
  currentSession: () => string | undefined;
  presence?: SessionPresence;
  now?: () => number;
  scheduleFrame?: FrameScheduler;
}

export class ArcPane implements Pane {
  readonly members: SessionsOverviewModel;
  readonly tray: PaneTrayModel;
  private readonly tasks: PaneTasks;
  private readonly pendingRefresh: FrameCoalescer;
  private readonly unsubscribe: (() => void) | undefined;
  private lastPageRows = 20;

  constructor(
    readonly id: string,
    notify: () => void,
    private readonly intents: PaneIntents,
    private readonly options: ArcPaneOptions,
  ) {
    this.tasks = new PaneTasks(notify);
    this.pendingRefresh = new FrameCoalescer(options.scheduleFrame ?? nextFrame, () =>
      this.refresh(),
    );
    this.members = new SessionsOverviewModel(
      () => this.tasks.emit(),
      {
        refresh: () => this.refresh(),
        activate: (sessionId) => this.tasks.track(() => this.focusOrOpen(sessionId)),
        drill: () => {},
      },
      {
        order: "created",
        currentSession: options.currentSession,
        ...(options.presence !== undefined && { presence: options.presence }),
        ...(options.now !== undefined && { now: options.now }),
      },
    );
    this.tray = new PaneTrayModel(
      () => this.tasks.emit(),
      () => this.trayCommands(),
    );
    this.unsubscribe = options.sessions.subscribe?.(() => this.pendingRefresh.request());
    this.refresh();
  }

  dispose(): void {
    this.tasks.dispose();
    this.unsubscribe?.();
    this.pendingRefresh.dispose();
  }

  title(): string {
    const count = this.members.sessionCount();
    return paneTitle(
      arcTag(this.options.slug),
      count === 0 ? undefined : pluralize(count, "session"),
    );
  }

  describe(): PaneDescriptor {
    return { kind: "arc", arc: this.options.slug };
  }

  handleKey(chord: Chord, sequence?: string): boolean {
    if (this.tray.open) return this.tray.handleKey(chord, sequence);
    if (this.tray.opensOn(chord)) {
      this.tray.openTray();
      return true;
    }
    return this.members.handleKey(chord, this.lastPageRows);
  }

  handleMouse(local: { x: number; y: number }, event: PointerEvent): boolean {
    if (event.type !== "down" || this.tasks.failure() !== undefined) return false;
    const row = local.y - 1;
    if (row < 0 || row >= this.lastPageRows) return false;
    return this.members.activateVisible(row, this.lastPageRows);
  }

  settled(): Promise<void> {
    return this.tasks.settled();
  }

  refresh(): void {
    this.tasks.track(async () => {
      const items = (await this.options.sessions.overview?.()) ?? [];
      this.members.setItems(items.filter((item) => item.arc === this.options.slug));
    });
  }

  view(context: PaneContext): PaneView {
    const { theme, height, width } = context;
    const innerWidth = paneContentWidth(width);
    const tray = this.tray.open ? paneTrayView(this.tray, innerWidth, theme) : undefined;
    this.lastPageRows = Math.max(0, paneContentHeight(height) - (tray?.rows ?? 0));
    return paneChrome(
      context,
      this.title(),
      ...this.bodyLines(theme, this.lastPageRows, innerWidth),
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

  private bodyLines(theme: Theme, rows: number, width: number): PaneChild[] {
    const failure = this.tasks.failure();
    if (failure !== undefined) return [paneFailureLine(failure, theme, width)];
    return rowsView(this.members, rows, theme, width, {
      empty: "░ no sessions in this arc yet · ctrl+k s inside a member adds one",
      text: (row) => memberRowLine(row),
      line: (row) => memberRowView(row, theme, width),
    });
  }

  private trayCommands(): TrayCommand[] {
    return trayCommandsPressing((chord) => this.handleKey(chord), memberTray);
  }
}

export interface MemberRowParts {
  readonly lead: string;
  readonly title: string;
  readonly facts: string;
}

export function memberRowParts(row: SessionOverviewRow): MemberRowParts {
  return {
    lead: `${livenessMark[row.liveness]} `,
    title: row.title,
    facts: ` · ${livenessWord[row.liveness]} · ${row.age}`,
  };
}

export function memberRowLine(row: SessionOverviewRow): string {
  const { lead, title, facts } = memberRowParts(row);
  return `${lead}${title}${facts}`;
}

const livenessWord: Record<SessionLiveness, string> = {
  busy: "working",
  attached: "idle",
  idle: "closed",
};

const memberTray: readonly KeyedTrayCommand[] = [
  { name: "open", description: "open the selected session", key: "enter" },
  { name: "refresh", description: "reload this arc's sessions", key: "r" },
];

function memberRowView(row: SessionOverviewRow, theme: Theme, width: number): PaneChild {
  const color = row.current ? theme.accentSoft : theme.text;
  const { lead, title, facts } = memberRowParts(row);
  const chunks = [
    fg(color)(lead),
    ...slugChunks(title, slugInk(theme, color)),
    fg(theme.textDim)(facts),
  ];
  return Text({ content: new StyledText(clipSpans(chunks, width)) });
}
