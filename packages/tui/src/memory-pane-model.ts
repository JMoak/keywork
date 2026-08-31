import type { AirlockDigestView, CandidateChoice, QuestionChoice } from "./arcs.ts";
import type { Chord } from "./keys.ts";
import {
  type AirlockRowRef,
  type DigestTreatment,
  findNote,
  gardenRows,
  ledgerRows,
  type MemoryRow,
  type MemoryRowKind,
  noteRows,
  queryRows,
} from "./memory-rows.ts";
import { isPrintable } from "./picker-keys.ts";
import { RowCursor } from "./row-cursor.ts";

export type MemoryProvenance = "user" | "agent" | "untrusted";
export type CuringStage = 0 | 1 | 2 | 3;
export type MemoryLens = "garden" | "note" | "ledger";
export type MemoryLayerKind = "workspace" | "arc" | "user";

export interface PromptBudgetView {
  budget: number;
  used: number;
}

export interface MemoryLayerView {
  id: string;
  kind: MemoryLayerKind;
  label: string;
  arc?: string;
  prompt?: PromptBudgetView;
}

export interface NoteRelationView {
  name: string;
  predicate: string;
  direction: "out" | "in";
}

export interface MemoryNoteView {
  name: string;
  title: string;
  layer: string;
  provenance: MemoryProvenance;
  curing: CuringStage;
  links: string[];
  aliases: string[];
  path?: string;
  file?: string;
  body?: string;
  tokens?: number;
  pinned?: boolean;
  injected?: boolean;
  recalls?: number;
  created?: string;
  usefulness?: number;
  confidence?: number;
  supersedes?: string;
  supersededBy?: string;
  delivered?: string;
  distilledFrom?: string;
  relations?: NoteRelationView[];
}

export type InboxKind = "staged" | "promotion" | "contradiction" | "proposal" | "airlock";

export interface InboxItemView {
  id: string;
  kind: InboxKind;
  title: string;
  provenance: MemoryProvenance;
  created: string;
  detail?: string;
  arc?: string;
  note?: string;
}

export interface LedgerEventView {
  id?: string;
  at: string;
  verb: string;
  subject: string;
  notes: string[];
}

export interface GardenerActivityView {
  state: "idle" | "working" | "failed";
  phasesDone?: number;
  phaseCount?: number;
  detail?: string;
  sweptAt?: string;
}

export interface MemoryPaneInputs {
  layers: MemoryLayerView[];
  notes: MemoryNoteView[];
  inbox: InboxItemView[];
  ledger: LedgerEventView[];
  gardener?: GardenerActivityView;
  airlocks?: AirlockDigestView[];
}

export type QueryLeg = "lexical" | "semantic" | "graph";
export type QuerySource = "lexical" | "hybrid" | "lexical-degraded";

export interface MemoryQueryHit {
  note: string;
  layer: string;
  ranks: Partial<Record<QueryLeg, number>>;
  boost?: number;
  superseded: boolean;
}

export interface MemoryQueryOutcome {
  hits: MemoryQueryHit[];
  source: QuerySource;
  embeddings?: string;
}

export interface MemoryQueryState {
  text: string;
  pending: boolean;
  outcome?: MemoryQueryOutcome;
}

export interface MemoryLensState {
  lens: MemoryLens;
  note?: string;
  query?: string;
}

export interface MemoryPaneEffects {
  refresh(): void;
  approve(id: string): void;
  discard(id: string): void;
  revert(ledgerId: string): void;
  openFile(path: string): void;
  ask(query: string): void;
  notice?(text: string): void;
  triageCandidate?(arc: string, note: string, choice: CandidateChoice): void;
  triageQuestion?(arc: string, title: string, choice: QuestionChoice): void;
  deliverEligible?(arc: string): void;
  finishClose?(arc: string, force: boolean): void;
}

export interface MemoryPaneSeams {
  focusedArc?: () => string | undefined;
  now?: () => number;
  digestTreatment?: DigestTreatment;
}

export const emptyMemoryInputs: MemoryPaneInputs = {
  layers: [],
  notes: [],
  inbox: [],
  ledger: [],
};

export class MemoryPaneModel extends RowCursor<MemoryRow> {
  private inputs: MemoryPaneInputs = emptyMemoryInputs;
  private lens: MemoryLens = "garden";
  private focusedNote: string | undefined;
  private ledgerNote: string | undefined;
  private query: MemoryQueryState | undefined;
  private readonly unfoldedArcs = new Set<string>();
  private bodyWidth = 40;

  constructor(
    notify: () => void,
    private readonly effects: MemoryPaneEffects,
    private readonly seams: MemoryPaneSeams = {},
  ) {
    super(notify);
  }

  setInputs(inputs: MemoryPaneInputs): void {
    this.mutate(() => {
      this.inputs = inputs;
      if (this.focusedNote !== undefined && this.findNote(this.focusedNote) === undefined) {
        this.focusedNote = undefined;
        if (this.lens === "note") this.lens = "garden";
      }
    });
  }

  setBodyWidth(width: number): void {
    if (width === this.bodyWidth) return;
    this.rebuild(() => {
      this.bodyWidth = width;
    });
  }

  setQueryOutcome(query: string, outcome: MemoryQueryOutcome): void {
    if (this.query === undefined || this.query.text !== query) return;
    this.mutate(() => {
      this.query = { text: query, pending: false, outcome };
    });
  }

  restore(state: MemoryLensState): void {
    this.mutate(() => {
      const note = state.note === undefined ? undefined : this.findNote(state.note)?.name;
      this.focusedNote = note;
      this.ledgerNote = state.lens === "ledger" ? note : undefined;
      this.lens = state.lens === "note" && note === undefined ? "garden" : state.lens;
      if (state.query !== undefined && state.query !== "") this.beginQuery(state.query);
    });
  }

  state(): MemoryLensState {
    const note = this.lensNote();
    return {
      lens: this.lens,
      ...(note !== undefined && { note }),
      ...(this.query !== undefined && this.query.text !== "" && { query: this.query.text }),
    };
  }

  currentLens(): MemoryLens {
    return this.lens;
  }

  focused(): string | undefined {
    return this.focusedNote;
  }

  asking(): boolean {
    return this.query !== undefined;
  }

  noteCount(): number {
    return this.inputs.notes.length;
  }

  stagedCount(): number {
    return this.inputs.inbox.filter((item) => item.kind === "staged").length;
  }

  handleKey(chord: Chord, pageRows: number, sequence?: string): boolean {
    if (this.query !== undefined && this.lens === "garden")
      return this.handleQueryKey(chord, pageRows, sequence);
    if (chord.shift || chord.ctrl || chord.meta) return false;
    if (this.navigate(chord, pageRows)) return true;
    switch (this.lens) {
      case "garden":
        return this.handleGardenKey(chord);
      case "note":
        return this.handleNoteKey(chord);
      case "ledger":
        return this.handleLedgerKey(chord);
    }
  }

  protected buildRows(): MemoryRow[] {
    const now = (this.seams.now ?? Date.now)();
    switch (this.lens) {
      case "garden":
        return this.query === undefined
          ? this.gardenRows(now)
          : queryRows(this.inputs, this.query, now);
      case "note":
        return this.noteLensRows(now);
      case "ledger":
        return ledgerRows(this.inputs, { note: this.ledgerNote, now });
    }
  }

  private gardenRows(now: number): MemoryRow[] {
    return gardenRows(this.inputs, {
      focusedArc: this.seams.focusedArc?.(),
      now,
      treatment: this.seams.digestTreatment ?? "tail",
      unfolded: (arc) => this.unfoldedArcs.has(arc),
    });
  }

  protected keyOf(row: MemoryRow): string {
    return row.id;
  }

  protected override selectable(row: MemoryRow): boolean {
    return row.selectable;
  }

  private noteLensRows(now: number): MemoryRow[] {
    const focus = this.focusedNote === undefined ? undefined : this.findNote(this.focusedNote);
    if (focus === undefined) return this.gardenRows(now);
    return noteRows(this.inputs, focus, { now, bodyWidth: this.bodyWidth });
  }

  private handleGardenKey(chord: Chord): boolean {
    const airlock = this.cursorRow()?.airlock;
    if (airlock !== undefined && this.handleAirlockKey(airlock, chord)) return true;
    switch (chord.name) {
      case "enter":
      case "return":
        return this.drillAtCursor();
      case "?":
        return this.mutate(() => this.beginQuery(""));
      case "tab":
      case "l":
        return this.showLedger(undefined);
      case "i":
        return this.jumpTo("inbox");
      case "g":
        return this.jumpTo("note");
      case "a":
        return this.actOnInbox((id) => this.effects.approve(id));
      case "d":
        return this.actOnInbox((id) => this.effects.discard(id));
      case "o":
        return this.openCursoredFile();
      case "u":
        return this.revertCursoredNote();
      case "r":
        this.effects.refresh();
        return true;
      default:
        return false;
    }
  }

  private handleNoteKey(chord: Chord): boolean {
    switch (chord.name) {
      case "escape":
      case "h":
      case "backspace":
        return this.leaveNote();
      case "enter":
      case "return":
        return this.drillAtCursor();
      case "tab":
      case "l":
        return this.showLedger(this.focusedNote);
      case "a":
        return this.actOnInbox((id) => this.effects.approve(id));
      case "d":
        return this.actOnInbox((id) => this.effects.discard(id));
      case "o":
        return this.openFocusedFile();
      case "u":
        return this.revertNote(this.focusedNote);
      case "r":
        this.effects.refresh();
        return true;
      default:
        return false;
    }
  }

  private handleLedgerKey(chord: Chord): boolean {
    switch (chord.name) {
      case "escape":
      case "backspace":
        return this.leaveLedger();
      case "tab":
        return this.showGarden();
      case "enter":
      case "return":
        return this.drillAtCursor();
      case "o":
        return this.openCursoredFile();
      case "u":
        return this.revertCursoredEntry();
      case "r":
        this.effects.refresh();
        return true;
      default:
        return false;
    }
  }

  private handleQueryKey(chord: Chord, pageRows: number, sequence: string | undefined): boolean {
    const query = this.query;
    if (query === undefined) return false;
    switch (chord.name) {
      case "escape":
        return this.mutate(() => {
          this.query = undefined;
        });
      case "enter":
      case "return":
        return this.drillAtCursor();
      case "tab":
        this.query = undefined;
        return this.showLedger(undefined);
      case "up":
      case "down":
      case "pageup":
      case "pagedown":
        return this.navigate(chord, pageRows);
      case "backspace":
        return this.mutate(() => this.beginQuery(query.text.slice(0, -1)));
      default:
        if (!isPrintable(chord, sequence)) return false;
        return this.mutate(() => this.beginQuery(query.text + sequence));
    }
  }

  private beginQuery(text: string): void {
    this.query = { text, pending: text !== "" };
    if (text !== "") this.effects.ask(text);
  }

  private drillAtCursor(): boolean {
    const row = this.cursorRow();
    const reference = row?.note;
    const focus = reference === undefined ? undefined : this.findNote(reference, row?.layer);
    if (focus === undefined) return true;
    return this.mutate(() => {
      this.focusedNote = focus.name;
      this.lens = "note";
    }, `focus:${focus.name}`);
  }

  private lensNote(): string | undefined {
    switch (this.lens) {
      case "garden":
        return undefined;
      case "note":
        return this.focusedNote;
      case "ledger":
        return this.ledgerNote;
    }
  }

  private leaveNote(): boolean {
    const returning = this.focusedNote;
    this.mutate(() => {
      this.lens = "garden";
    });
    if (returning !== undefined) this.settleOn((row) => row.selectable && row.note === returning);
    return true;
  }

  private showLedger(note: string | undefined): boolean {
    this.mutate(() => {
      this.ledgerNote = note;
      this.lens = "ledger";
    });
    return this.jumpTo("ledger");
  }

  private leaveLedger(): boolean {
    const returning = this.ledgerNote;
    if (returning !== undefined && this.findNote(returning) !== undefined) {
      return this.mutate(() => {
        this.focusedNote = returning;
        this.ledgerNote = undefined;
        this.lens = "note";
      }, `focus:${returning}`);
    }
    return this.showGarden();
  }

  private showGarden(): boolean {
    return this.mutate(() => {
      this.ledgerNote = undefined;
      this.lens = "garden";
    });
  }

  private jumpTo(kind: MemoryRowKind): boolean {
    const kinds: MemoryRowKind[] = kind === "inbox" ? ["inbox", "airlock"] : [kind];
    return this.settleOn((row) => kinds.includes(row.kind) && row.selectable);
  }

  private settleOn(wanted: (row: MemoryRow) => boolean): true {
    const at = this.rows().findIndex(wanted);
    if (at !== -1) this.moveTo(at);
    return true;
  }

  private handleAirlockKey(ref: AirlockRowRef, chord: Chord): boolean {
    switch (ref.kind) {
      case "candidate":
        return this.triageCandidate(ref, chord);
      case "question":
        return this.triageQuestion(ref, chord);
      case "fold":
        if (chord.name !== "space" && chord.name !== "enter" && chord.name !== "return")
          return false;
        return this.toggleFold(ref.arc);
      case "finish":
        return this.finishAirlock(ref, chord);
    }
  }

  private triageCandidate(ref: AirlockRowRef, chord: Chord): boolean {
    const choice = candidateChoices[chord.name];
    if (choice === undefined) return false;
    this.effects.triageCandidate?.(ref.arc, ref.key, choice);
    return true;
  }

  private triageQuestion(ref: AirlockRowRef, chord: Chord): boolean {
    const choice = questionChoices[chord.name];
    if (choice === undefined) return false;
    this.effects.triageQuestion?.(ref.arc, ref.key, choice);
    return true;
  }

  private finishAirlock(ref: AirlockRowRef, chord: Chord): boolean {
    switch (chord.name) {
      case "enter":
      case "return":
        this.effects.finishClose?.(ref.arc, false);
        return true;
      case "f":
        this.effects.finishClose?.(ref.arc, true);
        return true;
      case "a":
        this.effects.deliverEligible?.(ref.arc);
        return true;
      default:
        return false;
    }
  }

  private toggleFold(arc: string): boolean {
    return this.mutate(() => {
      if (this.unfoldedArcs.has(arc)) this.unfoldedArcs.delete(arc);
      else this.unfoldedArcs.add(arc);
    });
  }

  private actOnInbox(act: (id: string) => void): boolean {
    const inboxId = this.cursorRow()?.inboxId;
    if (inboxId !== undefined) act(inboxId);
    return true;
  }

  private openCursoredFile(): boolean {
    const row = this.cursorRow();
    const file = row?.file ?? this.fileOf(row?.note);
    if (file === undefined) this.effects.notice?.("nothing to open here");
    else this.effects.openFile(file);
    return true;
  }

  private openFocusedFile(): boolean {
    const file = this.fileOf(this.focusedNote);
    if (file === undefined) this.effects.notice?.("this note has no file to open");
    else this.effects.openFile(file);
    return true;
  }

  private revertCursoredNote(): boolean {
    return this.revertNote(this.cursorRow()?.note);
  }

  private revertNote(reference: string | undefined): boolean {
    const note = reference === undefined ? undefined : this.findNote(reference);
    if (note === undefined) {
      this.effects.notice?.("select a note to revert its last change");
      return true;
    }
    const entry = this.inputs.ledger.find(
      (event) => event.id !== undefined && event.notes.includes(note.name),
    );
    if (entry?.id === undefined) {
      this.effects.notice?.(`no change to revert for ${note.title} this run`);
      return true;
    }
    this.effects.revert(entry.id);
    return true;
  }

  private revertCursoredEntry(): boolean {
    const id = this.cursorRow()?.ledgerId;
    if (id === undefined) this.effects.notice?.("only this run's writes can be reverted");
    else this.effects.revert(id);
    return true;
  }

  private fileOf(reference: string | undefined): string | undefined {
    return reference === undefined ? undefined : this.findNote(reference)?.file;
  }

  private findNote(reference: string, layer?: string): MemoryNoteView | undefined {
    return findNote(this.inputs.notes, reference, layer);
  }
}

const candidateChoices: Partial<Record<string, CandidateChoice>> = { a: "deliver", d: "leave" };
const questionChoices: Partial<Record<string, QuestionChoice>> = {
  a: "resolve",
  c: "carry",
  d: "drop",
};
