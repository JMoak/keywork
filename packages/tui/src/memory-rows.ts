import { clampIndex } from "./clamp.ts";
import type {
  CuringStage,
  GardenerActivityView,
  InboxItemView,
  InboxKind,
  MemoryNoteView,
  MemoryPaneInputs,
  MemoryProvenance,
  RecallEventView,
} from "./memory-pane-model.ts";
import type { RowTone } from "./pane-chrome.ts";
import { pluralize } from "./pluralize.ts";

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

export function overviewRows(inputs: MemoryPaneInputs): MemoryRow[] {
  const { scopes, notes, inbox, recalls } = inputs;
  if (notes.length === 0 && inbox.length === 0 && recalls.length === 0) return calmRows(scopes);
  return [
    ...scopeRows(scopes, notes),
    ...inboxRows(inbox),
    ...gardenRows(notes, inputs.gardener),
    ...recallRows(recalls),
  ];
}

export function focusRows(notes: readonly MemoryNoteView[], focus: MemoryNoteView): MemoryRow[] {
  const linksOut = linksOutRows(notes, focus);
  const linksIn = linksInRows(notes, focus);
  const links =
    linksOut.length === 0 && linksIn.length === 0 ? [emptyRow("no-links", "no links yet")] : [];
  return [
    header(`note · ${focus.title}`),
    noteRow(focus, "note", `focus:${focus.name}`, 0),
    ...links,
    ...linksOut,
    ...linksIn,
  ];
}

export function findNote(
  notes: readonly MemoryNoteView[],
  reference: string,
): MemoryNoteView | undefined {
  return notes.find((note) => matchesNote(note, reference));
}

export function curingGlyph(stage: CuringStage): string {
  return densityRamp[stage];
}

export function provenanceGlyph(provenance: MemoryProvenance): string {
  return provenanceMarks[provenance];
}

const densityRamp = ["░", "▒", "▓", "█"] as const;
const provenanceMarks: Record<MemoryProvenance, string> = {
  user: "█",
  agent: "▓",
  untrusted: "░",
};
const inboxKindWords: Record<InboxKind, string> = {
  staged: "staged",
  promotion: "promote",
  contradiction: "conflict",
  proposal: "proposal",
};
const tileFill = ["▌", "▌▀", "▌▀▗", "█"] as const;
const recallLimit = 8;

function calmRows(scopes: readonly string[]): MemoryRow[] {
  const rows = [emptyRow("calm", "nothing remembered yet")];
  if (scopes.length > 0) rows.push(emptyRow("calm-scopes", scopes.join(" · ")));
  return rows;
}

function scopeRows(scopes: readonly string[], notes: readonly MemoryNoteView[]): MemoryRow[] {
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

function inboxRows(inbox: readonly InboxItemView[]): MemoryRow[] {
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

function gardenRows(
  notes: readonly MemoryNoteView[],
  gardener: GardenerActivityView | undefined,
): MemoryRow[] {
  if (notes.length === 0) return [];
  return [
    header("garden"),
    ...gardenerRow(gardener),
    ...notes.map((note) => noteRow(note, "note", `note:${note.name}`, 0)),
  ];
}

function gardenerRow(activity: GardenerActivityView | undefined): MemoryRow[] {
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

function recallRows(recalls: readonly RecallEventView[]): MemoryRow[] {
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

function linksOutRows(notes: readonly MemoryNoteView[], focus: MemoryNoteView): MemoryRow[] {
  const rows: MemoryRow[] = [];
  for (const link of focus.links) {
    const target = findNote(notes, link);
    if (target === undefined) {
      rows.push(deadLinkRow(`out:${link}`, link, 1));
      continue;
    }
    rows.push(noteRow(target, "link", `out:${target.name}`, 1));
    for (const hop of target.links) {
      if (matchesNote(focus, hop)) continue;
      const second = findNote(notes, hop);
      if (second === undefined) rows.push(deadLinkRow(`out:${target.name}:${hop}`, hop, 2));
      else rows.push(noteRow(second, "link", `out:${target.name}:${second.name}`, 2));
    }
  }
  return rows.length === 0 ? [] : [header("links out"), ...rows];
}

function linksInRows(notes: readonly MemoryNoteView[], focus: MemoryNoteView): MemoryRow[] {
  const sources = notes.filter(
    (note) => note.name !== focus.name && note.links.some((link) => matchesNote(focus, link)),
  );
  if (sources.length === 0) return [];
  return [
    header("links in"),
    ...sources.map((source) => noteRow(source, "backlink", `in:${source.name}`, 1)),
  ];
}

function header(text: string): MemoryRow {
  return { id: `header:${text}`, kind: "header", text, tone: "heading", selectable: false };
}

function emptyRow(id: string, text: string): MemoryRow {
  return { id, kind: "empty", text, tone: "dim", selectable: false };
}

function noteRow(note: MemoryNoteView, kind: MemoryRowKind, id: string, indent: number): MemoryRow {
  return {
    id,
    kind,
    text: `${"  ".repeat(indent)}${noteText(note)}`,
    tone: noteTone(note),
    selectable: true,
    note: note.name,
  };
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

function isFresh(stage: CuringStage): boolean {
  return stage <= 1;
}

function scopeText(name: string, count: number, fresh: number): string {
  const notes = pluralize(count, "note");
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

function matchesNote(note: MemoryNoteView, reference: string): boolean {
  const key = reference.trim().toLowerCase();
  if (key === "") return false;
  return (
    note.name.toLowerCase() === key ||
    note.title.toLowerCase() === key ||
    note.aliases.some((alias) => alias.toLowerCase() === key)
  );
}

function orderedScopesOf(notes: readonly MemoryNoteView[]): string[] {
  const scopes: string[] = [];
  for (const note of notes) if (!scopes.includes(note.scope)) scopes.push(note.scope);
  return scopes;
}
