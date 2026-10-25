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
  parentId?: string;
  working?: boolean;
  waiting?: WaitingFact;
  changes?: ChangesFact;
}

export interface WaitingFact {
  readonly asks: number;
  readonly tools: readonly string[];
}

export interface ChangesFact {
  readonly files: number;
  readonly added: number;
  readonly deleted: number;
}

export interface SessionPresence {
  paneFor(sessionId: string): string | undefined;
  busy(sessionId: string): boolean;
  waiting(sessionId: string): boolean;
  waitingAsks?(sessionId: string): WaitingFact | undefined;
  changes?(sessionId: string): ChangesFact | undefined;
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
  child?: true;
  desk?: string;
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
  remove?(sessionId: string, title: string): void;
  discard?(sessionId: string, title: string): void;
  purge?(count: number): void;
}

export interface PendingRemoval {
  sessionId: string;
  title: string;
}

export type PendingTrash =
  | { kind: "discard"; sessionId: string; title: string }
  | { kind: "purge"; count: number };

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
  private pendingRemoval: PendingRemoval | undefined;
  private pendingTrash: PendingTrash | undefined;

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

  removal(): PendingRemoval | undefined {
    return this.pendingRemoval;
  }

  awaiting(): boolean {
    return this.pendingRemoval !== undefined || this.pendingTrash !== undefined;
  }

  removalPrompt(): string | undefined {
    const pending = this.pendingRemoval;
    if (pending === undefined) return trashPrompt(this.pendingTrash);
    return `remove "${pending.title}"? enter trashes it, memory notes stay · any other key cancels`;
  }

  beginPurge(): boolean {
    if (this.effects.purge === undefined) return false;
    this.pendingTrash = { kind: "purge", count: this.items.length };
    this.notify();
    return true;
  }

  handleKey(chord: Chord, pageRows: number): boolean {
    if (this.pendingRemoval !== undefined) return this.handleRemovalKey(chord);
    if (this.pendingTrash !== undefined) return this.handleTrashKey(chord);
    if (chord.shift && chord.name === "d" && !chord.ctrl && !chord.meta) return this.beginPurge();
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
      case "x":
        return this.beginRemoval();
      case "d":
        return this.beginDiscard();
      case "r":
        this.effects.refresh();
        return true;
      default:
        return false;
    }
  }

  private beginRemoval(): boolean {
    if (this.effects.remove === undefined) return false;
    const row = this.cursorRow();
    if (row?.kind === "session") this.pendingRemoval = { sessionId: row.id, title: row.title };
    this.notify();
    return true;
  }

  private beginDiscard(): boolean {
    if (this.effects.discard === undefined) return false;
    const row = this.cursorRow();
    if (row?.kind === "session") {
      this.pendingTrash = { kind: "discard", sessionId: row.id, title: row.title };
    }
    this.notify();
    return true;
  }

  private handleTrashKey(chord: Chord): boolean {
    const pending = this.pendingTrash;
    this.pendingTrash = undefined;
    this.notify();
    if (pending === undefined || (chord.name !== "enter" && chord.name !== "return")) return true;
    if (pending.kind === "purge") this.effects.purge?.(pending.count);
    else this.effects.discard?.(pending.sessionId, pending.title);
    return true;
  }

  private handleRemovalKey(chord: Chord): boolean {
    const pending = this.pendingRemoval;
    this.pendingRemoval = undefined;
    this.notify();
    if (pending !== undefined && (chord.name === "enter" || chord.name === "return")) {
      this.effects.remove?.(pending.sessionId, pending.title);
    }
    return true;
  }

  protected buildRows(): OverviewRow[] {
    const now = (this.seams.now ?? Date.now)();
    const rowsOf = (items: readonly SessionOverviewItem[]) =>
      familyOrder(items).map((item) => this.sessionRow(item, now));
    if (this.grouping === "none") return rowsOf(this.items);
    const groups = groupItems(this.items, this.grouping);
    if (groups.every((group) => group.member === undefined)) return rowsOf(this.items);
    return groups.flatMap((group) => [this.groupRow(group, now), ...rowsOf(group.items)]);
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
      ...(item.parentId !== undefined && { child: true as const }),
      ...deskOf(this.deskFacts(item)),
    };
  }

  private deskFacts(item: SessionOverviewItem): DeskFacts {
    const presence = this.seams.presence;
    const live = presence?.paneFor(item.id) !== undefined;
    const waiting = live ? presence?.waitingAsks?.(item.id) : undefined;
    const changes = live ? presence?.changes?.(item.id) : undefined;
    return {
      working: item.working ?? (live && presence?.busy(item.id) === true),
      waiting: waiting ?? item.waiting,
      changes: changes ?? item.changes,
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
    const served = this.items.find((item) => item.id === sessionId);
    if ((served?.waiting?.asks ?? 0) > 0) return "waiting";
    if (served?.working === true) return "busy";
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

export function trashPrompt(pending: PendingTrash | undefined): string | undefined {
  if (pending === undefined) return undefined;
  if (pending.kind === "discard") {
    return `delete "${pending.title}" for good? there is no undo · enter deletes it · any other key cancels`;
  }
  const goes = `${sessionsFact(pending.count)} ${pending.count === 1 ? "goes" : "go"}`;
  return `empty the trash? ${goes} for good, there is no undo · enter empties it · any other key cancels`;
}

export function familyOrder(items: readonly SessionOverviewItem[]): SessionOverviewItem[] {
  const listed = new Set(items.map((item) => item.id));
  const nested = (item: SessionOverviewItem) =>
    item.parentId !== undefined && listed.has(item.parentId);
  const childrenOf = (parent: SessionOverviewItem) =>
    items.filter((item) => item.parentId === parent.id);
  return items.filter((item) => !nested(item)).flatMap((item) => [item, ...childrenOf(item)]);
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
    lead: `${livenessMark[row.liveness]} ${row.child === true ? childMark : ""}`,
    title: row.title,
    age: row.desk === undefined ? ` · ${row.age}` : ` · ${row.age} · ${row.desk}`,
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

const childMark = "↳ ";

interface DeskFacts {
  readonly working: boolean;
  readonly waiting: WaitingFact | undefined;
  readonly changes: ChangesFact | undefined;
}

function deskOf(facts: DeskFacts): { desk?: string } {
  const parts = [
    ...waitingWords(facts.waiting),
    ...(facts.working && (facts.waiting?.asks ?? 0) === 0 ? ["working"] : []),
    ...changesWords(facts.changes),
  ];
  return parts.length === 0 ? {} : { desk: parts.join(" · ") };
}

function waitingWords(waiting: WaitingFact | undefined): string[] {
  if (waiting === undefined || waiting.asks === 0) return [];
  const asks = waiting.asks === 1 ? "1 ask" : `${waiting.asks} asks`;
  return waiting.tools.length === 0 ? [asks] : [`${asks} · ${waiting.tools.join(", ")}`];
}

function changesWords(changes: ChangesFact | undefined): string[] {
  if (changes === undefined || changes.files === 0) return [];
  const files = changes.files === 1 ? "1 file" : `${changes.files} files`;
  return [`${files} +${changes.added} -${changes.deleted}`];
}

function countSummary(row: SessionOverviewRow): string {
  const parts = [`${row.entryCount}e`];
  if (row.branchCount > 0) parts.push(`${row.branchCount}b`);
  if (row.labelCount > 0) parts.push(`${row.labelCount}l`);
  if (row.cost !== undefined) parts.push(row.cost);
  return parts.join(" ");
}
