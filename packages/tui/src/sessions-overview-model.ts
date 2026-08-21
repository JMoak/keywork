import { formatCostNanos } from "@keywork/engine";
import { clampIndex, clampScroll } from "./clamp.ts";
import type { Chord } from "./keys.ts";

export interface SessionOverviewItem {
  id: string;
  title: string;
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
}

export type SessionLiveness = "busy" | "attached" | "idle";

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

export interface SessionsOverviewSeams {
  presence?: SessionPresence;
  currentSession?: () => string | undefined;
  now?: () => number;
}

export class SessionsOverviewModel {
  cursor = 0;
  scrollTop = 0;

  private items: SessionOverviewItem[] = [];
  private anchorId: string | undefined;

  constructor(
    private readonly notify: () => void,
    private readonly effects: SessionsOverviewEffects,
    private readonly seams: SessionsOverviewSeams = {},
  ) {}

  setItems(items: readonly SessionOverviewItem[]): void {
    this.anchorId = this.items[this.cursor]?.id ?? this.anchorId;
    this.items = [...items].sort((a, b) => b.modifiedAt - a.modifiedAt);
    this.reanchor();
    this.notify();
  }

  sessionCount(): number {
    return this.items.length;
  }

  rows(): SessionOverviewRow[] {
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

  visibleRows(rowCount: number): { index: number; row: SessionOverviewRow }[] {
    const all = this.rows();
    this.cursor = clampIndex(this.cursor, all.length);
    this.scrollTop = clampScroll(this.scrollTop, all.length, rowCount);
    if (this.cursor < this.scrollTop) this.scrollTop = this.cursor;
    if (this.cursor >= this.scrollTop + rowCount) this.scrollTop = this.cursor - rowCount + 1;
    return all
      .slice(this.scrollTop, this.scrollTop + rowCount)
      .map((row, offset) => ({ index: this.scrollTop + offset, row }));
  }

  cursorRow(): SessionOverviewRow | undefined {
    return this.rows()[clampIndex(this.cursor, this.items.length)];
  }

  activateVisible(offset: number, rowCount: number): boolean {
    const target = this.visibleRows(rowCount)[offset];
    if (target === undefined) return false;
    this.cursor = target.index;
    this.anchorId = target.row.id;
    this.notify();
    this.effects.activate(target.row.id);
    return true;
  }

  handleKey(chord: Chord, pageRows: number): boolean {
    this.cursor = clampIndex(this.cursor, this.items.length);
    if (chord.shift || chord.ctrl || chord.meta) return false;
    switch (chord.name) {
      case "j":
      case "down":
        return this.moveCursor(1);
      case "k":
      case "up":
        return this.moveCursor(-1);
      case "pagedown":
        return this.moveCursor(pageRows);
      case "pageup":
        return this.moveCursor(-pageRows);
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

  private moveCursor(delta: number): boolean {
    this.cursor = clampIndex(this.cursor + delta, this.items.length);
    this.anchorId = this.items[this.cursor]?.id ?? this.anchorId;
    this.notify();
    return true;
  }

  private withCursorSession(action: (sessionId: string) => void): boolean {
    const item = this.items[clampIndex(this.cursor, this.items.length)];
    if (item !== undefined) action(item.id);
    return true;
  }

  private livenessOf(sessionId: string): SessionLiveness {
    const presence = this.seams.presence;
    if (presence === undefined || presence.paneFor(sessionId) === undefined) return "idle";
    return presence.busy(sessionId) ? "busy" : "attached";
  }

  private reanchor(): void {
    if (this.items.length === 0) return;
    const wanted = this.anchorId ?? this.seams.currentSession?.();
    const found = this.items.findIndex((item) => item.id === wanted);
    this.cursor = found >= 0 ? found : clampIndex(this.cursor, this.items.length);
    this.anchorId = this.items[this.cursor]?.id;
  }
}

export const livenessMark: Record<SessionLiveness, string> = {
  busy: "█",
  attached: "▓",
  idle: "░",
};

export interface OverviewRowParts {
  readonly lead: string;
  readonly title: string;
  readonly tail: string;
}

export function overviewRowParts(row: SessionOverviewRow, cursored: boolean): OverviewRowParts {
  const arc = row.arc === undefined ? "" : ` #${row.arc}`;
  const counts = cursored ? ` · ${countSummary(row)}` : "";
  return {
    lead: `${livenessMark[row.liveness]} `,
    title: row.title,
    tail: ` · ${row.age}${arc}${counts}`,
  };
}

export function overviewRowLine(row: SessionOverviewRow, cursored: boolean): string {
  const { lead, title, tail } = overviewRowParts(row, cursored);
  return `${lead}${title}${tail}`;
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
