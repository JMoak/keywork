import { defaultSigil, formatCostNanos } from "@keywork/engine";
import { arcTag } from "./arcs.ts";
import type { Chord } from "./keys.ts";
import { sessionsFact } from "./pluralize.ts";
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
  bot?: string;
}

export interface SessionPresence {
  paneFor(sessionId: string): string | undefined;
  busy(sessionId: string): boolean;
  waiting(sessionId: string): boolean;
}

export type SessionLiveness = "waiting" | "busy" | "attached" | "idle";

export interface SessionOverviewRow {
  kind: "session";
  id: string;
  title: string;
  age: string;
  liveness: SessionLiveness;
  arc: string | undefined;
  bot: string | undefined;
  current: boolean;
  entryCount: number;
  branchCount: number;
  labelCount: number;
  cost: string | undefined;
}

export type SessionGroupAxis = "arc" | "bot";

export type SessionGroupBy = "none" | SessionGroupAxis;

export const sessionGroupings: readonly SessionGroupBy[] = ["none", "arc", "bot"];

export interface SessionGroupRow {
  kind: "group";
  axis: SessionGroupAxis;
  member: string | undefined;
  sigil: string | undefined;
  label: string;
  sessions: number;
  age: string;
}

export type OverviewRow = SessionOverviewRow | SessionGroupRow;

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
  groupBy?: SessionGroupBy;
  botSigil?: (name: string) => string | undefined;
}

export class SessionsOverviewModel extends RowCursor<OverviewRow> {
  protected override readonly volatileRows = true;

  private items: SessionOverviewItem[] = [];
  private grouping: SessionGroupBy;

  constructor(
    notify: () => void,
    private readonly effects: SessionsOverviewEffects,
    private readonly seams: SessionsOverviewSeams = {},
  ) {
    super(notify);
    this.grouping = seams.groupBy ?? "none";
  }

  setItems(items: readonly SessionOverviewItem[]): void {
    this.mutate(() => {
      this.items = [...items].sort(sessionOrders[this.seams.order ?? "recent"]);
    }, this.currentKey() ?? this.seams.currentSession?.());
  }

  sessionCount(): number {
    return this.items.length;
  }

  sessionRows(): SessionOverviewRow[] {
    return this.rows().filter(isSessionRow);
  }

  cursorSession(): string | undefined {
    const row = this.cursorRow();
    return row?.kind === "session" ? row.id : undefined;
  }

  groupBy(): SessionGroupBy {
    return this.grouping;
  }

  setGroupBy(groupBy: SessionGroupBy): void {
    if (groupBy === this.grouping) return;
    this.mutate(() => {
      this.grouping = groupBy;
    }, this.cursorSession());
  }

  cycleGroupBy(): true {
    const at = sessionGroupings.indexOf(this.grouping);
    this.setGroupBy(sessionGroupings[(at + 1) % sessionGroupings.length] ?? "none");
    return true;
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
      case "g":
        return this.cycleGroupBy();
      case "r":
        this.effects.refresh();
        return true;
      default:
        return false;
    }
  }

  protected buildRows(): OverviewRow[] {
    const now = (this.seams.now ?? Date.now)();
    if (this.grouping === "none") return this.items.map((item) => this.sessionRow(item, now));
    const groups = groupItems(this.items, this.grouping);
    if (groups.every((group) => group.member === undefined)) {
      return this.items.map((item) => this.sessionRow(item, now));
    }
    return groups.flatMap((group) => [
      this.groupRow(group, now),
      ...group.items.map((item) => this.sessionRow(item, now)),
    ]);
  }

  protected keyOf(row: OverviewRow): string {
    return row.kind === "session" ? row.id : `group:${row.axis}:${row.member ?? ""}`;
  }

  protected override selectable(row: OverviewRow): boolean {
    return row.kind === "session";
  }

  private sessionRow(item: SessionOverviewItem, now: number): SessionOverviewRow {
    return {
      kind: "session",
      id: item.id,
      title: item.title,
      age: relativeAge(now, item.modifiedAt),
      liveness: this.livenessOf(item.id),
      arc: item.arc,
      bot: item.bot,
      current: item.id === this.seams.currentSession?.(),
      entryCount: item.entryCount,
      branchCount: item.branchCount,
      labelCount: item.labelCount,
      cost: item.costNanos === undefined ? undefined : formatCostNanos(item.costNanos),
    };
  }

  private groupRow(group: ItemGroup, now: number): SessionGroupRow {
    const sigil = this.sigilOf(group);
    return {
      kind: "group",
      axis: group.axis,
      member: group.member,
      sigil,
      label: groupLabel(group, sigil),
      sessions: group.items.length,
      age: relativeAge(now, group.newestAt),
    };
  }

  private sigilOf(group: ItemGroup): string | undefined {
    if (group.axis !== "bot" || group.member === undefined) return undefined;
    return this.seams.botSigil?.(group.member) ?? defaultSigil(group.member);
  }

  private withCursorSession(action: (sessionId: string) => void): true {
    const sessionId = this.cursorSession();
    if (sessionId !== undefined) action(sessionId);
    return true;
  }

  private livenessOf(sessionId: string): SessionLiveness {
    const presence = this.seams.presence;
    if (presence === undefined || presence.paneFor(sessionId) === undefined) return "idle";
    if (presence.waiting(sessionId)) return "waiting";
    return presence.busy(sessionId) ? "busy" : "attached";
  }
}

interface ItemGroup {
  axis: SessionGroupAxis;
  member: string | undefined;
  items: SessionOverviewItem[];
  newestAt: number;
}

export function isSessionRow(row: OverviewRow): row is SessionOverviewRow {
  return row.kind === "session";
}

export function withoutArcTag(row: OverviewRow): OverviewRow {
  return row.kind === "session" ? { ...row, arc: undefined } : row;
}

function groupLabel(group: ItemGroup, sigil: string | undefined): string {
  if (group.member === undefined) return `no ${group.axis}`;
  if (group.axis === "arc") return arcTag(group.member);
  return sigil === undefined ? group.member : `${sigil} ${group.member}`;
}

function groupItems(items: readonly SessionOverviewItem[], axis: SessionGroupAxis): ItemGroup[] {
  const groups = new Map<string | undefined, ItemGroup>();
  for (const item of items) {
    const member = item[axis];
    const group = groups.get(member) ?? { axis, member, items: [], newestAt: item.modifiedAt };
    group.items.push(item);
    group.newestAt = Math.max(group.newestAt, item.modifiedAt);
    groups.set(member, group);
  }
  return [...groups.values()].sort(boundByRecencyThenUnbound);
}

function boundByRecencyThenUnbound(left: ItemGroup, right: ItemGroup): number {
  if ((left.member === undefined) !== (right.member === undefined)) {
    return left.member === undefined ? 1 : -1;
  }
  return right.newestAt - left.newestAt || (left.member ?? "").localeCompare(right.member ?? "");
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

export function overviewRowLine(row: OverviewRow, cursored: boolean): string {
  if (row.kind === "group") return groupRowLine(row);
  const { lead, title, age, arcTag: arc, counts } = overviewRowParts(row, cursored);
  return `${lead}${title}${age}${arc ?? ""}${counts}`;
}

export function groupRowLine(row: SessionGroupRow): string {
  return `${row.label} · ${sessionsFact(row.sessions)} · ${row.age}`;
}

export function groupByHint(groupBy: SessionGroupBy): string {
  return groupBy === "none" ? "g · group by arc or bot" : `g · grouped by ${groupBy}`;
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
