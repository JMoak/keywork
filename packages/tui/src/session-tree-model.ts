import { messageText, type SessionEntry, type SessionTreeNode } from "@keywork/engine";
import { clampIndex, clampScroll } from "./clamp.ts";
import type { Chord } from "./keys.ts";

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

export class SessionTreeModel {
  cursor = 0;
  scrollTop = 0;
  labelDraft: string | undefined;

  private view: SessionTreeView | undefined;
  private readonly collapsedIds = new Set<string>();
  private anchorId: string | undefined;
  private revision = 0;
  private cachedRows: { revision: number; rows: SessionTreeRow[] } | undefined;

  constructor(
    private readonly notify: () => void,
    private readonly effects: SessionTreeEffects,
  ) {}

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
    this.anchorId = this.rows()[this.cursor]?.id ?? this.anchorId;
    this.view = view;
    this.touch();
    this.reanchor();
    this.notify();
  }

  rows(): SessionTreeRow[] {
    if (this.cachedRows?.revision === this.revision) return this.cachedRows.rows;
    const rows: SessionTreeRow[] = [];
    this.collect(this.view?.roots ?? [], 0, rows);
    this.cachedRows = { revision: this.revision, rows };
    return rows;
  }

  visibleRows(rowCount: number): { index: number; row: SessionTreeRow }[] {
    const all = this.rows();
    this.cursor = clampIndex(this.cursor, all.length);
    this.scrollTop = clampScroll(this.scrollTop, all.length, rowCount);
    if (this.cursor < this.scrollTop) this.scrollTop = this.cursor;
    if (this.cursor >= this.scrollTop + rowCount) this.scrollTop = this.cursor - rowCount + 1;
    return all
      .slice(this.scrollTop, this.scrollTop + rowCount)
      .map((row, offset) => ({ index: this.scrollTop + offset, row }));
  }

  entryCount(): number {
    return this.rows().length;
  }

  cursorRow(): SessionTreeRow | undefined {
    return this.rows()[clampIndex(this.cursor, this.rows().length)];
  }

  selectVisible(offset: number, rowCount: number): boolean {
    const target = this.visibleRows(rowCount)[offset];
    if (target === undefined) return false;
    this.cursor = target.index;
    this.anchorId = target.row.id;
    this.notify();
    return true;
  }

  handleKey(chord: Chord, pageRows: number): boolean {
    if (this.labelDraft !== undefined) return this.handleLabelKey(chord);
    const rows = this.rows();
    this.cursor = clampIndex(this.cursor, rows.length);
    if (chord.shift && chord.name === "l") return this.beginLabel(rows[this.cursor]);
    switch (chord.name) {
      case "j":
      case "down":
        return this.moveCursor(1, rows);
      case "k":
      case "up":
        return this.moveCursor(-1, rows);
      case "pagedown":
        return this.moveCursor(pageRows, rows);
      case "pageup":
        return this.moveCursor(-pageRows, rows);
      case "h":
        return this.collapseOrJumpToParent(rows);
      case "l":
        return this.expand(rows[this.cursor]);
      case "enter":
      case "return":
        return this.toggleCollapse(rows[this.cursor]);
      case "r":
        this.effects.refresh();
        return true;
      case "f":
        return this.forkAtCursor(rows);
      default:
        return false;
    }
  }

  private handleLabelKey(chord: Chord): boolean {
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
        if (!isPrintable(chord)) return false;
        this.labelDraft = draft + (chord.name === "space" ? " " : chord.name);
        this.notify();
        return true;
    }
  }

  private beginLabel(row: SessionTreeRow | undefined): boolean {
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

  private forkAtCursor(rows: SessionTreeRow[]): boolean {
    const row = rows[this.cursor];
    if (row !== undefined) this.effects.fork(row.id);
    return true;
  }

  private moveCursor(delta: number, rows: SessionTreeRow[]): boolean {
    this.cursor = clampIndex(this.cursor + delta, rows.length);
    this.anchorId = rows[this.cursor]?.id;
    this.notify();
    return true;
  }

  private collapseOrJumpToParent(rows: SessionTreeRow[]): boolean {
    const row = rows[this.cursor];
    if (row === undefined) return true;
    if (row.hasChildren && !row.collapsed) {
      return this.mutate(() => this.collapsedIds.add(row.id));
    }
    if (row.parentId === null) return true;
    const parentAt = rows.findIndex((candidate) => candidate.id === row.parentId);
    if (parentAt >= 0) {
      this.cursor = parentAt;
      this.anchorId = rows[parentAt]?.id;
      this.notify();
    }
    return true;
  }

  private expand(row: SessionTreeRow | undefined): boolean {
    if (row === undefined || !row.collapsed) return true;
    return this.mutate(() => this.collapsedIds.delete(row.id));
  }

  private toggleCollapse(row: SessionTreeRow | undefined): boolean {
    if (row === undefined || !row.hasChildren) return true;
    return this.mutate(() => {
      if (!this.collapsedIds.delete(row.id)) this.collapsedIds.add(row.id);
    });
  }

  private mutate(action: () => void): boolean {
    this.anchorId = this.rows()[this.cursor]?.id ?? this.anchorId;
    action();
    this.touch();
    this.reanchor();
    this.notify();
    return true;
  }

  private touch(): void {
    this.revision += 1;
    this.cachedRows = undefined;
  }

  private reanchor(): void {
    const rows = this.rows();
    if (rows.length === 0) return;
    const found = rows.findIndex((row) => row.id === this.anchorId);
    this.cursor = found >= 0 ? found : clampIndex(this.cursor, rows.length);
    this.anchorId = rows[this.cursor]?.id ?? this.anchorId;
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
    case "custom":
      return entry.customType;
  }
}

function excerpt(text: string, limit = 48): string {
  const flat = text.replaceAll("\n", " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function isPrintable(chord: Chord): boolean {
  return (chord.name.length === 1 || chord.name === "space") && !chord.ctrl && !chord.meta;
}
