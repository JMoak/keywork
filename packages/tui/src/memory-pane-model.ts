import { clampIndex, clampScroll } from "./clamp.ts";
import type { Chord } from "./keys.ts";
import type { ThemeColorToken } from "./theme.ts";

export type MemoryProvenance = "user" | "agent" | "untrusted";
export type CuringStage = 0 | 1 | 2 | 3;
export type RowTone = "dim" | "normal" | "heading" | "alert";

export interface MemoryNoteView {
  name: string;
  title: string;
  scope: string;
  provenance: MemoryProvenance;
  curing: CuringStage;
  links: string[];
  aliases: string[];
  supersededBy?: string;
}

export type InboxKind = "staged" | "promotion" | "contradiction" | "proposal";

export interface InboxItemView {
  id: string;
  kind: InboxKind;
  title: string;
  provenance: MemoryProvenance;
  created: string;
  detail?: string;
}

export interface RecallEventView {
  note: string;
  scope: string;
  provenance: MemoryProvenance;
  annotation?: string;
}

export interface GardenerActivityView {
  state: "idle" | "working" | "failed";
  phasesDone?: number;
  phaseCount?: number;
  detail?: string;
}

export interface MemoryPaneInputs {
  scopes: string[];
  notes: MemoryNoteView[];
  inbox: InboxItemView[];
  recalls: RecallEventView[];
  gardener?: GardenerActivityView;
}

export interface MemoryPaneEffects {
  refresh(): void;
  approve(id: string): void;
  discard(id: string): void;
}

export type MemoryRowKind =
  | "header"
  | "scope"
  | "inbox"
  | "gardener"
  | "note"
  | "link"
  | "backlink"
  | "recall"
  | "empty";

export interface MemoryRow {
  id: string;
  kind: MemoryRowKind;
  text: string;
  tone: RowTone;
  selectable: boolean;
  note?: string;
  inboxId?: string;
}

export const emptyMemoryInputs: MemoryPaneInputs = {
  scopes: [],
  notes: [],
  inbox: [],
  recalls: [],
};

export function curingGlyph(stage: CuringStage): string {
  return densityRamp[stage];
}

export function provenanceGlyph(provenance: MemoryProvenance): string {
  return provenanceMarks[provenance];
}

export function toneToken(tone: RowTone): ThemeColorToken {
  return toneTokens[tone];
}

export interface RecallFeedEntry {
  note: string;
  scope: string;
  provenance: MemoryProvenance;
  cited?: boolean;
  supersededBy?: string;
}

export function recallView(entry: RecallFeedEntry): RecallEventView {
  const annotations = [
    ...(entry.cited === true ? ["cited"] : []),
    ...(entry.supersededBy === undefined ? [] : [`superseded by ${entry.supersededBy}`]),
  ];
  return {
    note: entry.note,
    scope: entry.scope,
    provenance: entry.provenance,
    ...(annotations.length > 0 && { annotation: annotations.join(" · ") }),
  };
}

export interface GardenerSweepCounts {
  promoted: number;
  merged: number;
  superseded: number;
  flagged: number;
}

export function gardenerSweepView(counts: GardenerSweepCounts): GardenerActivityView {
  const detail = (Object.entries(counts) as [string, number][])
    .filter(([, count]) => count > 0)
    .map(([phase, count]) => `${count} ${phase}`)
    .join(" · ");
  return { state: "idle", ...(detail !== "" && { detail }) };
}

export class MemoryPaneModel {
  cursor = 0;
  scrollTop = 0;

  private inputs: MemoryPaneInputs = emptyMemoryInputs;
  private focusedNote: string | undefined;
  private anchorId: string | undefined;
  private revision = 0;
  private cachedRows: { revision: number; rows: MemoryRow[] } | undefined;

  constructor(
    private readonly notify: () => void,
    private readonly effects: MemoryPaneEffects,
  ) {}

  setInputs(inputs: MemoryPaneInputs): void {
    this.anchorId = this.rows()[this.cursor]?.id ?? this.anchorId;
    this.inputs = inputs;
    if (this.focusedNote !== undefined && this.findNote(this.focusedNote) === undefined) {
      this.focusedNote = undefined;
    }
    this.touch();
    this.reanchor();
    this.notify();
  }

  focused(): string | undefined {
    return this.focusedNote;
  }

  noteCount(): number {
    return this.inputs.notes.length;
  }

  stagedCount(): number {
    return this.inputs.inbox.filter((item) => item.kind === "staged").length;
  }

  rows(): MemoryRow[] {
    if (this.cachedRows?.revision === this.revision) return this.cachedRows.rows;
    const focus = this.focusedNote === undefined ? undefined : this.findNote(this.focusedNote);
    const rows = focus === undefined ? this.overviewRows() : this.focusRows(focus);
    this.cachedRows = { revision: this.revision, rows };
    return rows;
  }

  visibleRows(rowCount: number): { index: number; row: MemoryRow }[] {
    const all = this.rows();
    this.cursor = clampIndex(this.cursor, all.length);
    this.scrollTop = clampScroll(this.scrollTop, all.length, rowCount);
    if (this.cursor < this.scrollTop) this.scrollTop = this.cursor;
    if (this.cursor >= this.scrollTop + rowCount) this.scrollTop = this.cursor - rowCount + 1;
    return all
      .slice(this.scrollTop, this.scrollTop + rowCount)
      .map((row, offset) => ({ index: this.scrollTop + offset, row }));
  }

  cursorRow(): MemoryRow | undefined {
    return this.rows()[clampIndex(this.cursor, this.rows().length)];
  }

  handleKey(chord: Chord, pageRows: number): boolean {
    if (chord.shift || chord.ctrl || chord.meta) return false;
    const rows = this.rows();
    this.cursor = clampIndex(this.cursor, rows.length);
    switch (chord.name) {
      case "j":
      case "down":
        return this.moveSelection(1, rows);
      case "k":
      case "up":
        return this.moveSelection(-1, rows);
      case "pagedown":
        return this.moveSelection(pageRows, rows);
      case "pageup":
        return this.moveSelection(-pageRows, rows);
      case "enter":
      case "return":
        return this.activate(rows[this.cursor]);
      case "i":
        return this.jumpTo("inbox", rows);
      case "g":
        return this.jumpTo("note", rows);
      case "a":
        return this.actOnInbox(rows[this.cursor], (id) => this.effects.approve(id));
      case "d":
        return this.actOnInbox(rows[this.cursor], (id) => this.effects.discard(id));
      case "h":
      case "escape":
        return this.leaveFocus();
      case "r":
        this.effects.refresh();
        return true;
      default:
        return false;
    }
  }

  private overviewRows(): MemoryRow[] {
    const { scopes, notes, inbox, recalls } = this.inputs;
    if (notes.length === 0 && inbox.length === 0 && recalls.length === 0) {
      return this.calmRows(scopes);
    }
    return [
      ...this.scopeRows(scopes, notes),
      ...this.inboxRows(inbox),
      ...this.gardenRows(notes),
      ...this.recallRows(recalls),
    ];
  }

  private calmRows(scopes: string[]): MemoryRow[] {
    const rows: MemoryRow[] = [
      {
        id: "calm",
        kind: "empty",
        text: "nothing remembered yet",
        tone: "dim",
        selectable: false,
      },
    ];
    if (scopes.length > 0) {
      rows.push({
        id: "calm-scopes",
        kind: "empty",
        text: scopes.join(" · "),
        tone: "dim",
        selectable: false,
      });
    }
    return rows;
  }

  private scopeRows(scopes: string[], notes: MemoryNoteView[]): MemoryRow[] {
    const names = scopes.length > 0 ? scopes : orderedScopesOf(notes);
    if (names.length === 0) return [];
    return [
      header("scopes"),
      ...names.map((name) => {
        const inScope = notes.filter((note) => note.scope === name);
        const fresh = inScope.filter((note) => isFresh(note.curing)).length;
        return {
          id: `scope:${name}`,
          kind: "scope" as const,
          text: scopeText(name, inScope.length, fresh),
          tone: "normal" as const,
          selectable: false,
        };
      }),
    ];
  }

  private inboxRows(inbox: InboxItemView[]): MemoryRow[] {
    if (inbox.length === 0) return [];
    const ordered = [...inbox].sort((a, b) => a.created.localeCompare(b.created));
    return [
      header(`inbox ░${inbox.length}`),
      ...ordered.map((item) => ({
        id: `inbox:${item.id}`,
        kind: "inbox" as const,
        text: inboxText(item),
        tone: "normal" as const,
        selectable: true,
        inboxId: item.id,
      })),
    ];
  }

  private gardenRows(notes: MemoryNoteView[]): MemoryRow[] {
    if (notes.length === 0) return [];
    return [
      header("garden"),
      ...this.gardenerRow(),
      ...notes.map((note) => this.noteRow(note, "note", `note:${note.name}`, 0)),
    ];
  }

  private gardenerRow(): MemoryRow[] {
    const activity = this.inputs.gardener;
    if (activity === undefined) return [];
    return [
      {
        id: "gardener",
        kind: "gardener",
        text: gardenerText(activity),
        tone: activity.state === "failed" ? "alert" : "dim",
        selectable: false,
      },
    ];
  }

  private recallRows(recalls: RecallEventView[]): MemoryRow[] {
    if (recalls.length === 0) return [];
    const firstShown = Math.max(0, recalls.length - recallLimit);
    return [
      header("recalls"),
      ...recalls.slice(firstShown).map((recall, at) => ({
        id: `recall:${firstShown + at}:${recall.note}`,
        kind: "recall" as const,
        text: recallText(recall),
        tone: "normal" as const,
        selectable: true,
        note: recall.note,
      })),
    ];
  }

  private focusRows(focus: MemoryNoteView): MemoryRow[] {
    return [
      header(`note · ${focus.title}`),
      this.noteRow(focus, "note", `focus:${focus.name}`, 0),
      ...this.linksOutRows(focus),
      ...this.linksInRows(focus),
    ];
  }

  private linksOutRows(focus: MemoryNoteView): MemoryRow[] {
    const rows: MemoryRow[] = [header("links out")];
    for (const link of focus.links) {
      const target = this.findNote(link);
      if (target === undefined) {
        rows.push(deadLinkRow(`out:${link}`, link, 1));
        continue;
      }
      rows.push(this.noteRow(target, "link", `out:${target.name}`, 1));
      for (const hop of target.links) {
        if (matchesNote(focus, hop)) continue;
        const second = this.findNote(hop);
        if (second === undefined) rows.push(deadLinkRow(`out:${target.name}:${hop}`, hop, 2));
        else rows.push(this.noteRow(second, "link", `out:${target.name}:${second.name}`, 2));
      }
    }
    const linksIn = this.backlinksOf(focus);
    if (rows.length === 1 && linksIn.length === 0) {
      return [
        { id: "no-links", kind: "empty", text: "no links yet", tone: "dim", selectable: false },
      ];
    }
    return rows.length === 1 ? [] : rows;
  }

  private linksInRows(focus: MemoryNoteView): MemoryRow[] {
    const sources = this.backlinksOf(focus);
    if (sources.length === 0) return [];
    return [
      header("links in"),
      ...sources.map((source) => this.noteRow(source, "backlink", `in:${source.name}`, 1)),
    ];
  }

  private backlinksOf(focus: MemoryNoteView): MemoryNoteView[] {
    return this.inputs.notes.filter(
      (note) => note.name !== focus.name && note.links.some((link) => matchesNote(focus, link)),
    );
  }

  private noteRow(
    note: MemoryNoteView,
    kind: MemoryRowKind,
    id: string,
    indent: number,
  ): MemoryRow {
    return {
      id,
      kind,
      text: `${"  ".repeat(indent)}${noteText(note)}`,
      tone: noteTone(note),
      selectable: true,
      note: note.name,
    };
  }

  private findNote(reference: string): MemoryNoteView | undefined {
    return this.inputs.notes.find((note) => matchesNote(note, reference));
  }

  private moveSelection(delta: number, rows: MemoryRow[]): boolean {
    const selectable = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.selectable);
    if (selectable.length === 0) return true;
    const at = selectable.findIndex(({ index }) => index >= this.cursor);
    const current = at === -1 ? selectable.length - 1 : at;
    const next = clampIndex(current + delta, selectable.length);
    this.cursor = selectable[next]?.index ?? this.cursor;
    this.anchorId = rows[this.cursor]?.id;
    this.notify();
    return true;
  }

  private activate(row: MemoryRow | undefined): boolean {
    if (row?.note === undefined) return true;
    if (this.findNote(row.note) === undefined) return true;
    this.anchorId = undefined;
    this.focusedNote = row.note;
    this.cursor = 0;
    this.scrollTop = 0;
    this.touch();
    this.settleOnSelectable();
    this.notify();
    return true;
  }

  private leaveFocus(): boolean {
    if (this.focusedNote === undefined) return true;
    const returning = this.focusedNote;
    this.focusedNote = undefined;
    this.touch();
    this.anchorId = `note:${returning}`;
    this.reanchor();
    this.notify();
    return true;
  }

  private jumpTo(kind: MemoryRowKind, rows: MemoryRow[]): boolean {
    const at = rows.findIndex((row) => row.kind === kind && row.selectable);
    if (at === -1) return true;
    this.cursor = at;
    this.anchorId = rows[at]?.id;
    this.notify();
    return true;
  }

  private actOnInbox(row: MemoryRow | undefined, act: (id: string) => void): boolean {
    if (row?.inboxId === undefined) return true;
    act(row.inboxId);
    return true;
  }

  private settleOnSelectable(): void {
    const rows = this.rows();
    const at = rows.findIndex((row) => row.selectable);
    this.cursor = at === -1 ? 0 : at;
  }

  private touch(): void {
    this.revision += 1;
    this.cachedRows = undefined;
  }

  private reanchor(): void {
    const rows = this.rows();
    if (rows.length === 0) {
      this.cursor = 0;
      return;
    }
    const found = rows.findIndex((row) => row.id === this.anchorId);
    this.cursor = found >= 0 ? found : clampIndex(this.cursor, rows.length);
    if (!(rows[this.cursor]?.selectable ?? false)) this.settleOnSelectable();
    this.anchorId = rows[this.cursor]?.id ?? this.anchorId;
  }
}

const densityRamp = ["░", "▒", "▓", "█"] as const;
const provenanceMarks: Record<MemoryProvenance, string> = {
  user: "█",
  agent: "▓",
  untrusted: "░",
};
const toneTokens: Record<RowTone, ThemeColorToken> = {
  dim: "textDim",
  normal: "text",
  heading: "accentSoft",
  alert: "error",
};
const inboxKindWords: Record<InboxKind, string> = {
  staged: "staged",
  promotion: "promote",
  contradiction: "conflict",
  proposal: "proposal",
};
const tileFill = ["▌", "▌▀", "▌▀▗", "█"] as const;
const recallLimit = 8;

function header(text: string): MemoryRow {
  return { id: `header:${text}`, kind: "header", text, tone: "heading", selectable: false };
}

function isFresh(stage: CuringStage): boolean {
  return stage <= 1;
}

function scopeText(name: string, count: number, fresh: number): string {
  const notes = `${count} ${count === 1 ? "note" : "notes"}`;
  return fresh === 0 ? `${name} · ${notes}` : `${name} · ${notes} · ${fresh} fresh`;
}

function inboxText(item: InboxItemView): string {
  const detail = item.detail === undefined ? "" : ` · ${item.detail}`;
  return `${provenanceGlyph(item.provenance)} ${inboxKindWords[item.kind]} · ${item.title}${detail}`;
}

function noteText(note: MemoryNoteView): string {
  const marks = `${curingGlyph(note.curing)}${provenanceGlyph(note.provenance)}`;
  const title = isFresh(note.curing) ? `~${note.title}` : note.title;
  const superseded = note.supersededBy === undefined ? "" : ` → ${note.supersededBy}`;
  return `${marks} ${title}${superseded}`;
}

function noteTone(note: MemoryNoteView): RowTone {
  if (note.supersededBy !== undefined) return "dim";
  return isFresh(note.curing) ? "dim" : "normal";
}

function gardenerText(activity: GardenerActivityView): string {
  const detail = activity.detail === undefined ? "" : ` · ${activity.detail}`;
  if (activity.state === "failed") return `gardener ▛${detail}`;
  if (activity.state === "idle") return `gardener █ idle${detail}`;
  return `gardener ${tileFillGlyph(activity)}${detail}`;
}

function tileFillGlyph(activity: GardenerActivityView): string {
  const { phasesDone, phaseCount } = activity;
  if (phasesDone === undefined || phaseCount === undefined || phaseCount === 0) {
    return tileFill[0];
  }
  const step = Math.floor((phasesDone / phaseCount) * (tileFill.length - 1));
  return tileFill[clampIndex(step, tileFill.length)] ?? tileFill[0];
}

function recallText(recall: RecallEventView): string {
  const annotation = recall.annotation === undefined ? "" : ` · ${recall.annotation}`;
  return `${provenanceGlyph(recall.provenance)} ${recall.note} · ${recall.scope}${annotation}`;
}

function deadLinkRow(id: string, link: string, indent: number): MemoryRow {
  return {
    id,
    kind: "link",
    text: `${"  ".repeat(indent)}? ${link}`,
    tone: "dim",
    selectable: false,
  };
}

function matchesNote(note: MemoryNoteView, reference: string): boolean {
  const key = reference.trim().toLowerCase();
  if (key === "") return false;
  return (
    note.name.toLowerCase() === key ||
    note.title.toLowerCase() === key ||
    note.aliases.some((alias) => alias.toLowerCase() === key)
  );
}

function orderedScopesOf(notes: MemoryNoteView[]): string[] {
  const scopes: string[] = [];
  for (const note of notes) if (!scopes.includes(note.scope)) scopes.push(note.scope);
  return scopes;
}
