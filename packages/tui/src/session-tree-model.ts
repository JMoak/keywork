import { messageText, type SessionEntry, type SessionTreeNode } from "@keywork/engine";
import type { Chord } from "./keys.ts";
import { isPrintable } from "./picker-keys.ts";
import { RowCursor } from "./row-cursor.ts";

export interface SessionTreeView {
  sessionId: string;
  name?: string;
  roots: SessionTreeNode[];
}

export interface SessionTreeEffects {
  refresh(): void;
  fork(entryId: string): void;
  setLabel(entryId: string, label: string | undefined): void;
}

export interface SessionTreeRow {
  id: string;
  parentId: string | null;
  depth: number;
  text: string;
  label: string | undefined;
  onActivePath: boolean;
  hasChildren: boolean;
  branchPoint: boolean;
  collapsed: boolean;
}

export class SessionTreeModel extends RowCursor<SessionTreeRow> {
  labelDraft: string | undefined;

  private view: SessionTreeView | undefined;
  private readonly collapsedIds = new Set<string>();

  constructor(
    notify: () => void,
    private readonly effects: SessionTreeEffects,
  ) {
    super(notify);
  }

  sessionId(): string | undefined {
    return this.view?.sessionId;
  }

  sessionName(): string | undefined {
    return this.view?.name;
  }

  get labeling(): boolean {
    return this.labelDraft !== undefined;
  }

  setView(view: SessionTreeView | undefined): void {
    this.mutate(() => {
      this.view = view;
    });
  }

  entryCount(): number {
    return this.rows().length;
  }

  handleKey(chord: Chord, pageRows: number, sequence?: string): boolean {
    if (this.labelDraft !== undefined) return this.handleLabelKey(chord, sequence);
    if (chord.shift && chord.name === "l") return this.beginLabel();
    if (chord.shift || chord.ctrl || chord.meta) return false;
    if (this.navigate(chord, pageRows)) return true;
    switch (chord.name) {
      case "h":
        return this.collapseOrJumpToParent();
      case "l":
        return this.expand();
      case "enter":
      case "return":
        return this.toggleCollapse();
      case "r":
        this.effects.refresh();
        return true;
      case "f":
        return this.forkAtCursor();
      default:
        return false;
    }
  }

  protected buildRows(): SessionTreeRow[] {
    const rows: SessionTreeRow[] = [];
    this.collect(this.view?.roots ?? [], 0, rows);
    return rows;
  }

  protected keyOf(row: SessionTreeRow): string {
    return row.id;
  }

  private handleLabelKey(chord: Chord, sequence: string | undefined): boolean {
    const draft = this.labelDraft ?? "";
    switch (chord.name) {
      case "escape":
        this.labelDraft = undefined;
        this.notify();
        return true;
      case "enter":
      case "return":
        return this.commitLabel(draft.trim());
      case "backspace":
        this.labelDraft = draft.slice(0, -1);
        this.notify();
        return true;
      default:
        if (!isPrintable(chord, sequence)) return false;
        this.labelDraft = draft + sequence;
        this.notify();
        return true;
    }
  }

  private beginLabel(): boolean {
    const row = this.cursorRow();
    if (row === undefined) return true;
    this.labelDraft = row.label ?? "";
    this.notify();
    return true;
  }

  private commitLabel(label: string): boolean {
    const row = this.cursorRow();
    this.labelDraft = undefined;
    if (row !== undefined) this.effects.setLabel(row.id, label === "" ? undefined : label);
    this.notify();
    return true;
  }

  private forkAtCursor(): boolean {
    const row = this.cursorRow();
    if (row !== undefined) this.effects.fork(row.id);
    return true;
  }

  private collapseOrJumpToParent(): boolean {
    const row = this.cursorRow();
    if (row === undefined) return true;
    if (row.hasChildren && !row.collapsed) return this.mutate(() => this.collapsedIds.add(row.id));
    if (row.parentId === null) return true;
    const parentAt = this.rows().findIndex((candidate) => candidate.id === row.parentId);
    if (parentAt >= 0) this.moveTo(parentAt);
    return true;
  }

  private expand(): boolean {
    const row = this.cursorRow();
    if (row === undefined || !row.collapsed) return true;
    return this.mutate(() => this.collapsedIds.delete(row.id));
  }

  private toggleCollapse(): boolean {
    const row = this.cursorRow();
    if (row === undefined || !row.hasChildren) return true;
    return this.mutate(() => {
      if (!this.collapsedIds.delete(row.id)) this.collapsedIds.add(row.id);
    });
  }

  private collect(nodes: readonly SessionTreeNode[], depth: number, out: SessionTreeRow[]): void {
    for (const node of nodes) {
      const collapsed = node.children.length > 0 && this.collapsedIds.has(node.entry.id);
      out.push({
        id: node.entry.id,
        parentId: node.entry.parentId,
        depth,
        text: entryText(node.entry),
        label: node.label,
        onActivePath: node.onActivePath,
        hasChildren: node.children.length > 0,
        branchPoint: node.children.length > 1,
        collapsed,
      });
      if (collapsed) continue;
      this.collect(node.children, depth + (node.children.length > 1 ? 1 : 0), out);
    }
  }
}

function entryText(entry: SessionEntry): string {
  switch (entry.type) {
    case "message":
      return `${entry.message.role}: ${excerpt(messageText(entry.message))}`;
    case "compaction":
      return `compacted · ${entry.tokensBefore} tokens summarized`;
    case "branch_summary":
      return `branch summary: ${excerpt(entry.summary)}`;
    case "label":
      return entry.label === undefined ? "label cleared" : `label ${entry.label}`;
    case "session_info":
      return `named "${entry.name ?? ""}"`;
    case "custom_message":
      return excerpt(entry.content);
    case "thinking_level_change":
      return `thinking → ${entry.thinkingLevel}`;
    case "model_change":
      return `model → ${entry.provider}/${entry.modelId}`;
    case "arc_binding":
      return entry.arc === undefined ? "arc released" : `arc → ${entry.arc}`;
    case "custom":
      return entry.customType;
  }
}

function excerpt(text: string, limit = 48): string {
  const flat = text.replaceAll("\n", " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}
