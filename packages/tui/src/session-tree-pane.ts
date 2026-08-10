import { Text } from "@opentui/core";
import type { Chord } from "./keys.ts";
import type { Pane, PaneContext, PaneDescriptor, PaneIntents, PaneView } from "./pane.ts";
import { paneChrome, paneTitle } from "./pane-chrome.ts";
import {
  SessionTreeModel,
  type SessionTreeRow,
  type SessionTreeView,
} from "./session-tree-model.ts";
import type { Theme } from "./theme.ts";

export interface SessionTreePort {
  load(sessionId: string): Promise<SessionTreeView | undefined>;
  setLabel(sessionId: string, entryId: string, label: string | undefined): Promise<void>;
  fork(sessionId: string, entryId: string): Promise<string | undefined>;
}

export class SessionTreePane implements Pane {
  readonly model: SessionTreeModel;
  private sessionId: string | undefined;
  private failure: string | undefined;
  private readonly pending = new Set<Promise<void>>();
  private lastPageRows = 20;

  constructor(
    readonly id: string,
    private readonly notify: () => void,
    intents: PaneIntents,
    private readonly port: SessionTreePort,
    private readonly targetSession: () => string | undefined,
    initialSessionId?: string,
  ) {
    this.sessionId = initialSessionId;
    this.model = new SessionTreeModel(notify, {
      refresh: () => this.refresh(),
      fork: (entryId) => this.track(this.fork(entryId, intents)),
      setLabel: (entryId, label) => this.track(this.relabel(entryId, label)),
    });
    this.refresh();
  }

  title(): string {
    const count = this.model.entryCount();
    const name = this.model.sessionName() ?? "session tree";
    return paneTitle(name, count === 0 ? undefined : `${count} entries`);
  }

  describe(): PaneDescriptor {
    return {
      kind: "session-tree",
      ...(this.sessionId !== undefined && { sessionId: this.sessionId }),
    };
  }

  handleKey(chord: Chord): boolean {
    return this.model.handleKey(chord, this.lastPageRows);
  }

  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  refresh(): void {
    const target = this.targetSession() ?? this.sessionId;
    if (target === undefined) return;
    this.sessionId = target;
    this.track(this.port.load(target).then((view) => this.model.setView(view)));
  }

  view(context: PaneContext): PaneView {
    const { theme, focused, height, width } = context;
    const labelLine = this.labelLine(theme, focused);
    this.lastPageRows = Math.max(3, height - 3 - (labelLine === undefined ? 0 : 1));
    return paneChrome(
      context,
      this.title(),
      ...this.bodyLines(theme, this.lastPageRows, Math.max(10, width - 4)),
      ...(labelLine === undefined ? [] : [labelLine]),
    );
  }

  private async fork(entryId: string, intents: PaneIntents): Promise<void> {
    if (this.sessionId === undefined) return;
    const forkedId = await this.port.fork(this.sessionId, entryId);
    if (forkedId !== undefined) intents.openSession(forkedId);
  }

  private async relabel(entryId: string, label: string | undefined): Promise<void> {
    if (this.sessionId === undefined) return;
    await this.port.setLabel(this.sessionId, entryId, label);
    this.model.setView(await this.port.load(this.sessionId));
  }

  private track(work: Promise<void>): void {
    const settled = work
      .then(() => {
        this.failure = undefined;
      })
      .catch((cause: unknown) => {
        this.failure = (cause as Error).message;
      })
      .then(() => {
        this.pending.delete(settled);
        this.notify();
      });
    this.pending.add(settled);
  }

  private bodyLines(theme: Theme, rows: number, width: number) {
    if (this.failure !== undefined) {
      return [Text({ content: this.failure.slice(0, width), fg: theme.error })];
    }
    if (this.model.sessionId() === undefined) {
      return [Text({ content: "no session yet — r retries", fg: theme.textDim })];
    }
    const visible = this.model.visibleRows(rows);
    if (visible.length === 0) return [Text({ content: "empty session", fg: theme.textDim })];
    return visible.map(({ index, row }) =>
      this.rowLine(row, index === this.model.cursor, theme, width),
    );
  }

  private rowLine(row: SessionTreeRow, selected: boolean, theme: Theme, width: number) {
    const content = rowText(row).slice(0, width);
    if (selected) {
      return Text({ content: content.padEnd(width), fg: theme.background, bg: theme.accent });
    }
    return Text({ content, fg: row.onActivePath ? theme.accentSoft : theme.text });
  }

  private labelLine(theme: Theme, focused: boolean) {
    if (!this.model.labeling) return undefined;
    const caret = focused ? "▌" : "";
    return Text({ content: `label: ${this.model.labelDraft ?? ""}${caret}`, fg: theme.accent });
  }
}

function rowText(row: SessionTreeRow): string {
  const indent = "  ".repeat(row.depth);
  const affordance = row.collapsed ? "▸ " : row.branchPoint ? "▾ " : "  ";
  const marker = row.onActivePath ? "●" : "○";
  const label = row.label === undefined ? "" : ` [${row.label}]`;
  return `${indent}${affordance}${marker} ${row.text}${label}`;
}
