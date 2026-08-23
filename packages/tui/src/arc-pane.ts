import { fg, StyledText, Text } from "@opentui/core";
import { type ArcOrdinals, arcInk, arcTag } from "./arcs.ts";
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
  arcOrdinal?: ArcOrdinals;
  now?: () => number;
  scheduleFrame?: FrameScheduler;
}

export type MemberPlacement = "shown" | "folded" | "closed";

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
    const folded = this.memberIds("folded").length;
    const facts = [
      count === 0 ? undefined : pluralize(count, "session"),
      folded === 0 ? undefined : `${folded} folded`,
    ].filter((fact) => fact !== undefined);
    const name = this.foldedMemberAwaitsYou()
      ? `${needsYouStamp} ${arcTag(this.options.slug)}`
      : arcTag(this.options.slug);
    return paneTitle(name, facts.length === 0 ? undefined : facts.join(" · "));
  }

  describe(): PaneDescriptor {
    return { kind: "arc", arc: this.options.slug };
  }

  placementOf(sessionId: string): MemberPlacement {
    const paneId = this.paneOf(sessionId);
    if (paneId === undefined) return "closed";
    return this.intents.paneHeld?.(paneId) === true ? "folded" : "shown";
  }

  handleKey(chord: Chord, sequence?: string): boolean {
    if (this.tray.open) return this.tray.handleKey(chord, sequence);
    if (this.tray.opensOn(chord)) {
      this.tray.openTray();
      return true;
    }
    if (this.handleFoldKey(chord)) return true;
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

  private handleFoldKey(chord: Chord): boolean {
    if (chord.shift || chord.ctrl || chord.meta) return false;
    switch (chord.name) {
      case "space":
        return this.toggleFoldAtCursor();
      case "a":
        return this.toggleAll();
      default:
        return false;
    }
  }

  private toggleFoldAtCursor(): true {
    const row = this.members.cursorRow();
    if (row === undefined) return true;
    switch (this.placementOf(row.id)) {
      case "shown":
        this.fold(row.id);
        break;
      case "folded":
        this.unfold(row.id);
        break;
      case "closed":
        this.intents.notice?.("closed session · enter opens it");
        break;
    }
    this.tasks.emit();
    return true;
  }

  private toggleAll(): true {
    const shown = this.memberIds("shown");
    if (shown.length > 0) for (const sessionId of shown) this.fold(sessionId);
    else for (const sessionId of this.memberIds("folded")) this.unfold(sessionId);
    this.tasks.emit();
    return true;
  }

  private fold(sessionId: string): void {
    const paneId = this.paneOf(sessionId);
    if (paneId !== undefined) this.intents.holdPane?.(paneId);
  }

  private unfold(sessionId: string): void {
    const paneId = this.paneOf(sessionId);
    if (paneId !== undefined) this.intents.showPane?.(paneId, this.cluster());
  }

  private cluster(): string[] {
    const memberPanes = this.members
      .rows()
      .map((row) => this.paneOf(row.id))
      .filter((paneId) => paneId !== undefined);
    return [...memberPanes, this.id];
  }

  private memberIds(placement: MemberPlacement): string[] {
    return this.members
      .rows()
      .map((row) => row.id)
      .filter((sessionId) => this.placementOf(sessionId) === placement);
  }

  private foldedMemberAwaitsYou(): boolean {
    return this.members
      .rows()
      .some((row) => row.liveness === "waiting" && this.placementOf(row.id) === "folded");
  }

  private paneOf(sessionId: string): string | undefined {
    return this.options.presence?.paneFor(sessionId);
  }

  private focusOrOpen(sessionId: string): Promise<void> {
    if (this.placementOf(sessionId) === "folded") this.unfold(sessionId);
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
    const ink = arcInk(theme, this.options.arcOrdinal?.(this.options.slug));
    return rowsView(this.members, rows, theme, width, {
      empty: "░ no sessions in this arc yet · ctrl+k s inside a member adds one",
      text: (row) => memberRowLine(row, this.placementOf(row.id)),
      line: (row) => memberRowView(row, this.placementOf(row.id), theme, width, ink),
    });
  }

  private trayCommands(): TrayCommand[] {
    return trayCommandsPressing((chord) => this.handleKey(chord), memberTray);
  }
}

export interface MemberRowParts {
  readonly lead: string;
  readonly title: string;
  readonly state: string;
  readonly age: string;
}

export function memberRowParts(
  row: SessionOverviewRow,
  placement: MemberPlacement,
): MemberRowParts {
  const restingFolded = placement === "folded" && row.liveness === "attached";
  return {
    lead: `${restingFolded ? foldMark : livenessMark[row.liveness]} `,
    title: row.title,
    state: ` · ${stateWord(row.liveness, placement)}`,
    age: ` · ${row.age}`,
  };
}

export function memberRowLine(row: SessionOverviewRow, placement: MemberPlacement): string {
  const { lead, title, state, age } = memberRowParts(row, placement);
  return `${lead}${title}${state}${age}`;
}

const foldMark = "░";
const needsYouStamp = "█";

const livenessWord: Record<SessionLiveness, string> = {
  waiting: "needs you",
  busy: "working",
  attached: "idle",
  idle: "closed",
};

const memberTray: readonly KeyedTrayCommand[] = [
  { name: "open", description: "open the selected session, unfolding it first", key: "enter" },
  { name: "fold", description: "fold or unfold the selected session", key: "space" },
  { name: "fold all", description: "fold every shown session, or unfold them all", key: "a" },
  { name: "refresh", description: "reload this arc's sessions", key: "r" },
];

function stateWord(liveness: SessionLiveness, placement: MemberPlacement): string {
  return placement === "folded" && liveness === "attached" ? "folded" : livenessWord[liveness];
}

function memberRowView(
  row: SessionOverviewRow,
  placement: MemberPlacement,
  theme: Theme,
  width: number,
  arcHue: string,
): PaneChild {
  const color =
    placement === "folded" ? theme.textDim : row.current ? theme.accentSoft : theme.text;
  const attention = row.liveness === "waiting" ? arcHue : undefined;
  const { lead, title, state, age } = memberRowParts(row, placement);
  const chunks = [
    fg(attention ?? color)(lead),
    ...slugChunks(title, slugInk(theme, color)),
    fg(attention ?? theme.textDim)(state),
    fg(theme.textDim)(age),
  ];
  return Text({ content: new StyledText(clipSpans(chunks, width)) });
}
