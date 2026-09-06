import { formatCostNanos } from "@keywork/engine";
import { type ArcStatus, type ArcSummary, isArcSlug } from "./arcs.ts";
import type { Chord } from "./keys.ts";
import { isPrintable } from "./picker-keys.ts";
import { sessionsFact } from "./pluralize.ts";
import { RowCursor } from "./row-cursor.ts";
import {
  livenessMark,
  relativeAge,
  type SessionLiveness,
  type SessionOverviewItem,
  type SessionPresence,
  SessionsOverviewModel,
} from "./sessions-overview-model.ts";

export type ArcGroupKey = { kind: "arc"; slug: string } | { kind: "unbound" };

export interface ArcGroupRow {
  key: ArcGroupKey;
  label: string;
  status: ArcStatus | undefined;
  sessions: number;
  liveness: SessionLiveness;
  age: string;
  cost: string | undefined;
  costPartial: boolean;
  current: boolean;
}

export type ArcsLevel = "arcs" | "sessions";

export interface ArcsPaneEffects {
  refresh(): void;
  activate(sessionId: string): void;
  create(slug: string): void;
  close(slug: string): void;
  abandon(slug: string): void;
  reject(reason: string): void;
}

export interface ArcsPaneSeams {
  presence?: SessionPresence;
  currentSession?: () => string | undefined;
  now?: () => number;
  drilled?: ArcGroupKey;
}

export class ArcsPaneModel extends RowCursor<ArcGroupRow> {
  nameDraft: string | undefined;
  readonly sessions: SessionsOverviewModel;
  protected override readonly volatileRows = true;

  private arcs: ArcSummary[] = [];
  private items: SessionOverviewItem[] = [];
  private drilledGroup: ArcGroupKey | undefined;

  constructor(
    notify: () => void,
    private readonly effects: ArcsPaneEffects,
    private readonly seams: ArcsPaneSeams = {},
  ) {
    super(notify);
    this.drilledGroup = seams.drilled;
    this.sessions = new SessionsOverviewModel(
      notify,
      { refresh: () => effects.refresh(), activate: (id) => effects.activate(id), drill: () => {} },
      {
        ...(seams.presence !== undefined && { presence: seams.presence }),
        ...(seams.currentSession !== undefined && { currentSession: seams.currentSession }),
        ...(seams.now !== undefined && { now: seams.now }),
      },
    );
  }

  level(): ArcsLevel {
    return this.drilledGroup === undefined ? "arcs" : "sessions";
  }

  drilled(): ArcGroupKey | undefined {
    return this.drilledGroup;
  }

  get naming(): boolean {
    return this.nameDraft !== undefined;
  }

  setInputs(arcs: readonly ArcSummary[], items: readonly SessionOverviewItem[]): void {
    this.mutate(() => {
      this.arcs = [...arcs];
      this.items = [...items];
      this.sessions.setItems(this.memberItems(this.drilledGroup));
    });
  }

  arcCount(): number {
    return this.arcs.filter((arc) => arc.status === "active").length;
  }

  drillInto(key: ArcGroupKey): void {
    this.drilledGroup = key;
    this.sessions.setItems(this.memberItems(key));
    this.notify();
  }

  returnToArcs(): boolean {
    this.drilledGroup = undefined;
    this.notify();
    return true;
  }

  handleKey(chord: Chord, pageRows: number, sequence?: string): boolean {
    if (this.nameDraft !== undefined) return this.handleNameKey(chord, sequence);
    if (this.drilledGroup !== undefined) return this.handleSessionsKey(chord, pageRows);
    if (chord.shift && chord.name === "a") return this.abandonAtCursor();
    if (chord.shift || chord.ctrl || chord.meta) return false;
    if (this.navigate(chord, pageRows)) return true;
    switch (chord.name) {
      case "enter":
      case "return":
      case "l":
      case "right":
        return this.drillAtCursor();
      case "n":
        return this.beginNaming();
      case "c":
        return this.closeAtCursor();
      case "r":
        this.effects.refresh();
        return true;
      default:
        return false;
    }
  }

  protected buildRows(): ArcGroupRow[] {
    const now = (this.seams.now ?? Date.now)();
    const current = this.seams.currentSession?.();
    const groups = [
      ...this.arcs.filter((arc) => arc.status === "active").map((arc) => this.arcRow(arc, now)),
      ...this.unboundRow(now),
      ...this.arcs.filter((arc) => arc.status === "archived").map((arc) => this.arcRow(arc, now)),
    ];
    return groups.map((row) => ({ ...row, current: this.holdsSession(row.key, current) }));
  }

  protected keyOf(row: ArcGroupRow): string {
    return row.key.kind === "arc" ? `arc:${row.key.slug}` : "unbound";
  }

  private handleSessionsKey(chord: Chord, pageRows: number): boolean {
    if (chord.name === "escape" || chord.name === "backspace") return this.returnToArcs();
    return this.sessions.handleKey(chord, pageRows);
  }

  private handleNameKey(chord: Chord, sequence: string | undefined): boolean {
    const draft = this.nameDraft ?? "";
    switch (chord.name) {
      case "escape":
        this.nameDraft = undefined;
        this.notify();
        return true;
      case "enter":
      case "return":
        return this.commitName(draft.trim());
      case "backspace":
        this.nameDraft = draft.slice(0, -1);
        this.notify();
        return true;
      default:
        if (!isPrintable(chord, sequence)) return false;
        this.nameDraft = draft + sequence;
        this.notify();
        return true;
    }
  }

  private beginNaming(): boolean {
    this.nameDraft = "";
    this.notify();
    return true;
  }

  private commitName(slug: string): boolean {
    this.nameDraft = undefined;
    this.notify();
    if (slug === "") return true;
    if (!isArcSlug(slug)) {
      this.effects.reject(`"${slug}" isn't an arc slug · lowercase letters, digits, inner hyphens`);
      return true;
    }
    if (this.arcs.some((arc) => arc.slug === slug)) {
      this.effects.reject(`an arc named ${slug} already exists`);
      return true;
    }
    this.effects.create(slug);
    return true;
  }

  private drillAtCursor(): boolean {
    const row = this.cursorRow();
    if (row !== undefined) this.drillInto(row.key);
    return true;
  }

  private closeAtCursor(): boolean {
    const row = this.cursorRow();
    if (row?.key.kind === "arc" && row.status === "active") this.effects.close(row.key.slug);
    return true;
  }

  private abandonAtCursor(): boolean {
    const row = this.cursorRow();
    if (row?.key.kind === "arc" && row.status === "active") this.effects.abandon(row.key.slug);
    return true;
  }

  private arcRow(arc: ArcSummary, now: number): Omit<ArcGroupRow, "current"> {
    const members = this.memberItems({ kind: "arc", slug: arc.slug });
    const latest = Math.max(
      Date.parse(arc.created) || 0,
      ...members.map((item) => item.modifiedAt),
    );
    return {
      key: { kind: "arc", slug: arc.slug },
      label: arc.slug,
      status: arc.status,
      sessions: members.length,
      liveness: this.livenessOf(members),
      age: relativeAge(now, latest),
      ...this.costOf(members),
    };
  }

  private unboundRow(now: number): Omit<ArcGroupRow, "current">[] {
    const members = this.memberItems({ kind: "unbound" });
    if (members.length === 0) return [];
    return [
      {
        key: { kind: "unbound" },
        label: "no arc",
        status: undefined,
        sessions: members.length,
        liveness: this.livenessOf(members),
        age: relativeAge(now, Math.max(...members.map((item) => item.modifiedAt))),
        ...this.costOf(members),
      },
    ];
  }

  private memberItems(key: ArcGroupKey | undefined): SessionOverviewItem[] {
    if (key === undefined) return [];
    return this.items.filter((item) =>
      key.kind === "unbound" ? item.arc === undefined : item.arc === key.slug,
    );
  }

  private holdsSession(key: ArcGroupKey, sessionId: string | undefined): boolean {
    if (sessionId === undefined) return false;
    return this.memberItems(key).some((item) => item.id === sessionId);
  }

  private livenessOf(members: readonly SessionOverviewItem[]): SessionLiveness {
    const presence = this.seams.presence;
    if (presence === undefined) return "idle";
    const attached = members.filter((item) => presence.paneFor(item.id) !== undefined);
    if (attached.some((item) => presence.busy(item.id))) return "busy";
    return attached.length > 0 ? "attached" : "idle";
  }

  private costOf(members: readonly SessionOverviewItem[]): {
    cost: string | undefined;
    costPartial: boolean;
  } {
    const known = members.filter((item) => item.costNanos !== undefined);
    if (known.length === 0) return { cost: undefined, costPartial: false };
    const total = known.reduce((sum, item) => sum + (item.costNanos ?? 0), 0);
    return { cost: formatCostNanos(total), costPartial: known.length < members.length };
  }
}

export function arcGroupLine(row: ArcGroupRow, cursored: boolean): string {
  const { lead, label, facts } = arcGroupParts(row, cursored);
  return `${lead}${label}${facts}`;
}

export interface ArcGroupParts {
  readonly lead: string;
  readonly label: string;
  readonly facts: string;
}

export function arcGroupParts(row: ArcGroupRow, cursored: boolean): ArcGroupParts {
  const facts = [sessionsFact(row.sessions), row.age];
  if (row.status === "archived") facts.unshift("archived");
  if (cursored && row.cost !== undefined)
    facts.push(row.costPartial ? `${row.cost} + unpriced` : row.cost);
  return {
    lead: `${livenessMark[row.liveness]} `,
    label: row.label,
    facts: ` · ${facts.join(" · ")}`,
  };
}
