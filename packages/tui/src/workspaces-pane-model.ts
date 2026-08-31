import { isSlug } from "@keywork/shared";
import type { Chord } from "./keys.ts";
import { isPrintable } from "./picker-keys.ts";
import { pluralize } from "./pluralize.ts";
import { RowCursor } from "./row-cursor.ts";
import { livenessMark, relativeAge, type SessionLiveness } from "./sessions-overview-model.ts";
import type { WorkspaceChoice } from "./workspace-picker.ts";

export interface WorkspaceRow {
  slug: string | undefined;
  label: string;
  name: string;
  declared: boolean;
  current: boolean;
  liveness: SessionLiveness;
  focusDirs: readonly string[];
  sessions: number;
  age: string | undefined;
}

export interface FocusDirRow {
  dir: string;
}

export type WorkspacesLevel = "workspaces" | "focus";

export type WorkspaceDraft = { kind: "name" | "dir"; text: string };

export interface PendingSwitch {
  slug: string | undefined;
  label: string;
  liveTurns: number;
}

export interface WorkspacesPaneEffects {
  refresh(): void;
  activate(slug: string | undefined): void;
  create(slug: string): void;
  link(slug: string | undefined, dir: string): void;
  unlink(slug: string | undefined, dir: string): void;
  reject(reason: string): void;
}

export interface WorkspacesPaneSeams {
  now?: () => number;
  liveTurns?: () => number;
}

export class WorkspacesPaneModel extends RowCursor<WorkspaceRow> {
  draft: WorkspaceDraft | undefined;
  pendingSwitch: PendingSwitch | undefined;
  readonly focus: FocusDirsModel;
  protected override readonly volatileRows = true;

  private choices: WorkspaceChoice[] = [];
  private drilledInto: { slug: string | undefined } | undefined;

  constructor(
    notify: () => void,
    private readonly effects: WorkspacesPaneEffects,
    private readonly seams: WorkspacesPaneSeams = {},
  ) {
    super(notify);
    this.focus = new FocusDirsModel(notify);
  }

  level(): WorkspacesLevel {
    return this.drilledInto === undefined ? "workspaces" : "focus";
  }

  drilled(): WorkspaceRow | undefined {
    const drilled = this.drilledInto;
    if (drilled === undefined) return undefined;
    return this.rows().find((row) => row.slug === drilled.slug);
  }

  get editing(): boolean {
    return this.draft !== undefined;
  }

  setChoices(choices: readonly WorkspaceChoice[]): void {
    this.mutate(() => {
      this.choices = [...choices];
      this.focus.setDirs(this.drilled()?.focusDirs ?? []);
    });
  }

  workspaceCount(): number {
    return this.choices.filter((choice) => choice.declared).length;
  }

  drillInto(slug: string | undefined): void {
    this.drilledInto = { slug };
    this.focus.setDirs(this.drilled()?.focusDirs ?? []);
    this.notify();
  }

  returnToWorkspaces(): boolean {
    this.drilledInto = undefined;
    this.notify();
    return true;
  }

  handleKey(chord: Chord, pageRows: number, sequence?: string): boolean {
    if (this.draft !== undefined) return this.handleDraftKey(chord, sequence);
    if (this.pendingSwitch !== undefined) return this.handleConfirmKey(chord);
    if (this.drilledInto !== undefined) return this.handleFocusKey(chord, pageRows);
    if (chord.shift || chord.ctrl || chord.meta) return false;
    if (this.navigate(chord, pageRows)) return true;
    switch (chord.name) {
      case "enter":
      case "return":
        return this.activateAtCursor();
      case "n":
        return this.beginDraft("name");
      case "l":
        return this.beginDraft("dir");
      case "x":
      case "f":
      case "right":
        return this.drillAtCursor();
      case "r":
        this.effects.refresh();
        return true;
      default:
        return false;
    }
  }

  protected buildRows(): WorkspaceRow[] {
    const now = (this.seams.now ?? Date.now)();
    return this.choices
      .map((choice) => this.rowOf(choice, now))
      .sort((left, right) => this.order(left, right));
  }

  protected keyOf(row: WorkspaceRow): string {
    return row.label;
  }

  private order(left: WorkspaceRow, right: WorkspaceRow): number {
    if (left.current !== right.current) return left.current ? -1 : 1;
    const leftUsed = this.lastUsedOf(left);
    const rightUsed = this.lastUsedOf(right);
    if (leftUsed !== rightUsed) return rightUsed - leftUsed;
    return left.label.localeCompare(right.label);
  }

  private lastUsedOf(row: WorkspaceRow): number {
    return this.choices.find((choice) => choice.slug === row.slug)?.lastUsed ?? 0;
  }

  private rowOf(choice: WorkspaceChoice, now: number): WorkspaceRow {
    return {
      slug: choice.slug,
      label: choice.slug ?? "default",
      name: choice.name,
      declared: choice.declared,
      current: choice.current,
      liveness: choice.current ? this.currentLiveness() : "idle",
      focusDirs: choice.focusDirs,
      sessions: choice.sessions,
      age: choice.lastUsed === undefined ? undefined : relativeAge(now, choice.lastUsed),
    };
  }

  private currentLiveness(): SessionLiveness {
    return (this.seams.liveTurns?.() ?? 0) > 0 ? "busy" : "attached";
  }

  private handleFocusKey(chord: Chord, pageRows: number): boolean {
    if (chord.name === "escape" || chord.name === "backspace") return this.returnToWorkspaces();
    if (chord.shift || chord.ctrl || chord.meta) return false;
    if (this.focus.navigate(chord, pageRows)) return true;
    switch (chord.name) {
      case "x":
        return this.unlinkAtCursor();
      case "l":
        return this.beginDraft("dir");
      case "r":
        this.effects.refresh();
        return true;
      default:
        return false;
    }
  }

  private handleConfirmKey(chord: Chord): boolean {
    const pending = this.pendingSwitch;
    this.pendingSwitch = undefined;
    this.notify();
    if (pending !== undefined && (chord.name === "enter" || chord.name === "return")) {
      this.effects.activate(pending.slug);
    }
    return true;
  }

  private handleDraftKey(chord: Chord, sequence: string | undefined): boolean {
    const draft = this.draft;
    if (draft === undefined) return false;
    switch (chord.name) {
      case "escape":
        this.draft = undefined;
        this.notify();
        return true;
      case "enter":
      case "return":
        this.draft = undefined;
        this.notify();
        return this.commitDraft(draft.kind, draft.text.trim());
      case "backspace":
        this.draft = { ...draft, text: draft.text.slice(0, -1) };
        this.notify();
        return true;
      default:
        if (!isPrintable(chord, sequence)) return false;
        this.draft = { ...draft, text: draft.text + sequence };
        this.notify();
        return true;
    }
  }

  private beginDraft(kind: WorkspaceDraft["kind"]): boolean {
    if (kind === "dir") {
      const target = this.linkTarget();
      if (target === undefined) return true;
    }
    this.draft = { kind, text: "" };
    this.notify();
    return true;
  }

  private commitDraft(kind: WorkspaceDraft["kind"], text: string): boolean {
    if (text === "") return true;
    if (kind === "name") return this.createNamed(text);
    const target = this.linkTarget();
    if (target !== undefined) this.effects.link(target.slug, text);
    return true;
  }

  private createNamed(slug: string): boolean {
    if (!isSlug(slug) || slug === "default") {
      this.effects.reject(
        `"${slug}" isn't a workspace slug · lowercase letters, digits, inner hyphens`,
      );
      return true;
    }
    if (this.choices.some((choice) => choice.slug === slug)) {
      this.effects.reject(`a workspace named ${slug} already exists`);
      return true;
    }
    this.effects.create(slug);
    return true;
  }

  private linkTarget(): WorkspaceRow | undefined {
    const row = this.drilled() ?? this.cursorRow();
    if (row === undefined) return undefined;
    if (!row.declared) {
      this.effects.reject(`${row.label} isn't set up yet · /init declares it first`);
      return undefined;
    }
    return row;
  }

  private activateAtCursor(): boolean {
    const row = this.cursorRow();
    if (row === undefined) return true;
    if (row.current) {
      this.effects.reject(`already in ${row.label}`);
      return true;
    }
    const liveTurns = this.seams.liveTurns?.() ?? 0;
    if (liveTurns > 0) {
      this.pendingSwitch = { slug: row.slug, label: row.label, liveTurns };
      this.notify();
      return true;
    }
    this.effects.activate(row.slug);
    return true;
  }

  private drillAtCursor(): boolean {
    const row = this.cursorRow();
    if (row === undefined) return true;
    if (!row.declared) {
      this.effects.reject(`${row.label} isn't set up yet · /init declares it first`);
      return true;
    }
    this.drillInto(row.slug);
    return true;
  }

  private unlinkAtCursor(): boolean {
    const drilled = this.drilled();
    const row = this.focus.cursorRow();
    if (drilled === undefined || row === undefined) return true;
    this.effects.unlink(drilled.slug, row.dir);
    return true;
  }
}

export class FocusDirsModel extends RowCursor<FocusDirRow> {
  private dirs: string[];

  constructor(notify: () => void, dirs: readonly string[] = []) {
    super(notify);
    this.dirs = [...dirs];
  }

  setDirs(dirs: readonly string[]): void {
    this.mutate(() => {
      this.dirs = [...dirs];
    });
  }

  dirCount(): number {
    return this.dirs.length;
  }

  override navigate(chord: Chord, pageRows: number): boolean {
    return super.navigate(chord, pageRows);
  }

  protected buildRows(): FocusDirRow[] {
    return this.dirs.map((dir) => ({ dir }));
  }

  protected keyOf(row: FocusDirRow): string {
    return row.dir;
  }
}

export function workspaceLine(row: WorkspaceRow): string {
  const { lead, label, facts } = workspaceParts(row);
  return `${lead}${label}${facts}`;
}

export interface WorkspaceParts {
  readonly lead: string;
  readonly label: string;
  readonly facts: string;
}

export function workspaceParts(row: WorkspaceRow): WorkspaceParts {
  const facts = row.declared
    ? [
        ...(row.focusDirs.length === 0 ? [] : [row.focusDirs.join(", ")]),
        sessionsFact(row.sessions),
        ...(row.age === undefined ? [] : [row.age]),
      ]
    : ["not set up yet"];
  return {
    lead: `${livenessMark[row.liveness]} `,
    label: row.label,
    facts: ` · ${facts.join(" · ")}`,
  };
}

export function describeSwitch(pending: PendingSwitch): string {
  const running = pluralize(pending.liveTurns, "turn");
  return `switch to ${pending.label}? ${running} still running here · enter switches · esc keeps`;
}

function sessionsFact(count: number): string {
  return count === 0 ? "no sessions" : pluralize(count, "session");
}
