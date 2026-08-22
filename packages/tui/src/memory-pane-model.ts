import type { Chord } from "./keys.ts";
import {
  findNote,
  focusRows,
  type MemoryRow,
  type MemoryRowKind,
  overviewRows,
} from "./memory-rows.ts";
import { RowCursor } from "./row-cursor.ts";

export type MemoryProvenance = "user" | "agent" | "untrusted";
export type CuringStage = 0 | 1 | 2 | 3;

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

export const emptyMemoryInputs: MemoryPaneInputs = {
  scopes: [],
  notes: [],
  inbox: [],
  recalls: [],
};

export class MemoryPaneModel extends RowCursor<MemoryRow> {
  private inputs: MemoryPaneInputs = emptyMemoryInputs;
  private focusedNote: string | undefined;

  constructor(
    notify: () => void,
    private readonly effects: MemoryPaneEffects,
  ) {
    super(notify);
  }

  setInputs(inputs: MemoryPaneInputs): void {
    this.mutate(() => {
      this.inputs = inputs;
      if (this.focusedNote !== undefined && this.findNote(this.focusedNote) === undefined) {
        this.focusedNote = undefined;
      }
    });
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

  handleKey(chord: Chord, pageRows: number): boolean {
    if (chord.shift || chord.ctrl || chord.meta) return false;
    if (this.navigate(chord, pageRows)) return true;
    switch (chord.name) {
      case "enter":
      case "return":
        return this.focusCursoredNote();
      case "i":
        return this.jumpTo("inbox");
      case "g":
        return this.jumpTo("note");
      case "a":
        return this.actOnInbox((id) => this.effects.approve(id));
      case "d":
        return this.actOnInbox((id) => this.effects.discard(id));
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

  protected buildRows(): MemoryRow[] {
    const focus = this.focusedNote === undefined ? undefined : this.findNote(this.focusedNote);
    return focus === undefined ? overviewRows(this.inputs) : focusRows(this.inputs.notes, focus);
  }

  protected keyOf(row: MemoryRow): string {
    return row.id;
  }

  protected override selectable(row: MemoryRow): boolean {
    return row.selectable;
  }

  private findNote(reference: string): MemoryNoteView | undefined {
    return findNote(this.inputs.notes, reference);
  }

  private focusCursoredNote(): boolean {
    const reference = this.cursorRow()?.note;
    const focus = reference === undefined ? undefined : this.findNote(reference);
    if (focus === undefined) return true;
    return this.mutate(() => {
      this.focusedNote = focus.name;
    }, `focus:${focus.name}`);
  }

  private leaveFocus(): boolean {
    const returning = this.focusedNote;
    if (returning === undefined) return true;
    return this.mutate(() => {
      this.focusedNote = undefined;
    }, `note:${returning}`);
  }

  private jumpTo(kind: MemoryRowKind): boolean {
    const at = this.rows().findIndex((row) => row.kind === kind && row.selectable);
    if (at !== -1) this.moveTo(at);
    return true;
  }

  private actOnInbox(act: (id: string) => void): boolean {
    const inboxId = this.cursorRow()?.inboxId;
    if (inboxId !== undefined) act(inboxId);
    return true;
  }
}
