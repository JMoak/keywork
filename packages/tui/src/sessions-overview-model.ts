import { formatCostNanos } from "@keywork/engine";
import { arcTag } from "./arcs.ts";
import type { Chord } from "./keys.ts";
import { RowCursor } from "./row-cursor.ts";

export interface SessionOverviewItem {
  id: string;
  title: string;
  createdAt: number;
  modifiedAt: number;
  entryCount: number;
  branchCount: number;
  labelCount: number;
  costNanos?: number;
  arc?: string;
}

export interface SessionPresence {
  paneFor(sessionId: string): string | undefined;
  busy(sessionId: string): boolean;
  waiting(sessionId: string): boolean;
}

export type SessionLiveness = "waiting" | "busy" | "attached" | "idle";

export interface SessionOverviewRow {
  id: string;
  title: string;
  age: string;
  liveness: SessionLiveness;
  arc: string | undefined;
  current: boolean;
  entryCount: number;
  branchCount: number;
  labelCount: number;
  cost: string | undefined;
}

export interface SessionsOverviewEffects {
  refresh(): void;
  activate(sessionId: string): void;
  drill(sessionId: string): void;
}

export type SessionOrder = "recent" | "created";

export interface SessionsOverviewSeams {
  presence?: SessionPresence;
  currentSession?: () => string | undefined;
  now?: () => number;
  order?: SessionOrder;
}

export class SessionsOverviewModel extends RowCursor<SessionOverviewRow> {
  protected override readonly volatileRows = true;

  private items: SessionOverviewItem[] = [];

  constructor(
    notify: () => void,
    private readonly effects: SessionsOverviewEffects,
    private readonly seams: SessionsOverviewSeams = {},
  ) {
    super(notify);
  }

  setItems(items: readonly SessionOverviewItem[]): void {
    this.mutate(() => {
      this.items = [...items].sort(sessionOrders[this.seams.order ?? "recent"]);
    }, this.currentKey() ?? this.seams.currentSession?.());
  }

  sessionCount(): number {
    return this.items.length;
  }

  activateVisible(offset: number, rowCount: number): boolean {
    if (!this.selectVisible(offset, rowCount)) return false;
    return this.withCursorSession((sessionId) => this.effects.activate(sessionId));
  }

  handleKey(chord: Chord, pageRows: number): boolean {
    if (chord.shift || chord.ctrl || chord.meta) return false;
    if (this.navigate(chord, pageRows)) return true;
    switch (chord.name) {
      case "enter":
      case "return":
        return this.withCursorSession((sessionId) => this.effects.activate(sessionId));
      case "l":
      case "right":
        return this.withCursorSession((sessionId) => this.effects.drill(sessionId));
      case "r":
        this.effects.refresh();
        return true;
      default:
        return false;
    }
  }

  protected buildRows(): SessionOverviewRow[] {
    const now = (this.seams.now ?? Date.now)();
    const current = this.seams.currentSession?.();
    return this.items.map((item) => ({
      id: item.id,
      title: item.title,
      age: relativeAge(now, item.modifiedAt),
      liveness: this.livenessOf(item.id),
      arc: item.arc,
      current: item.id === current,
      entryCount: item.entryCount,
      branchCount: item.branchCount,
      labelCount: item.labelCount,
      cost: item.costNanos === undefined ? undefined : formatCostNanos(item.costNanos),
    }));
  }

  protected keyOf(row: SessionOverviewRow): string {
    return row.id;
  }

  private withCursorSession(action: (sessionId: string) => void): true {
    const row = this.cursorRow();
    if (row !== undefined) action(row.id);
    return true;
  }

  private livenessOf(sessionId: string): SessionLiveness {
    const presence = this.seams.presence;
    if (presence === undefined || presence.paneFor(sessionId) === undefined) return "idle";
    if (presence.waiting(sessionId)) return "waiting";
    return presence.busy(sessionId) ? "busy" : "attached";
  }
}

const sessionOrders: Record<
  SessionOrder,
  (a: SessionOverviewItem, b: SessionOverviewItem) => number
> = {
  recent: (a, b) => b.modifiedAt - a.modifiedAt,
  created: (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
};

export const livenessMark: Record<SessionLiveness, string> = {
  waiting: "█",
  busy: "█",
  attached: "▓",
  idle: "░",
};

export interface OverviewRowParts {
  readonly lead: string;
  readonly title: string;
  readonly age: string;
  readonly arcTag: string | undefined;
  readonly counts: string;
}

export function overviewRowParts(row: SessionOverviewRow, cursored: boolean): OverviewRowParts {
  return {
    lead: `${livenessMark[row.liveness]} `,
    title: row.title,
    age: ` · ${row.age}`,
    arcTag: row.arc === undefined ? undefined : ` ${arcTag(row.arc)}`,
    counts: cursored ? ` · ${countSummary(row)}` : "",
  };
}

export function overviewRowLine(row: SessionOverviewRow, cursored: boolean): string {
  const { lead, title, age, arcTag: arc, counts } = overviewRowParts(row, cursored);
  return `${lead}${title}${age}${arc ?? ""}${counts}`;
}

export function relativeAge(nowMs: number, thenMs: number): string {
  const minutes = Math.floor(Math.max(0, nowMs - thenMs) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

function countSummary(row: SessionOverviewRow): string {
  const parts = [`${row.entryCount}e`];
  if (row.branchCount > 0) parts.push(`${row.branchCount}b`);
  if (row.labelCount > 0) parts.push(`${row.labelCount}l`);
  if (row.cost !== undefined) parts.push(row.cost);
  return parts.join(" ");
}
