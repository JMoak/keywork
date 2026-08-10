import { Text } from "@opentui/core";
import type { Chord } from "./keys.ts";
import {
  type MemoryPaneInputs,
  MemoryPaneModel,
  type MemoryRow,
  toneToken,
} from "./memory-pane-model.ts";
import type { Pane, PaneContext, PaneDescriptor, PaneView } from "./pane.ts";
import { paneChrome, paneTitle } from "./pane-chrome.ts";
import type { Theme } from "./theme.ts";

export interface MemoryPanePort {
  load(): Promise<MemoryPaneInputs>;
  approve(id: string): Promise<void>;
  discard(id: string): Promise<void>;
}

export class MemoryPane implements Pane {
  readonly model: MemoryPaneModel;
  private failure: string | undefined;
  private readonly pending = new Set<Promise<void>>();
  private lastPageRows = 20;

  constructor(
    readonly id: string,
    private readonly notify: () => void,
    private readonly port: MemoryPanePort,
  ) {
    this.model = new MemoryPaneModel(notify, {
      refresh: () => this.refresh(),
      approve: (stagedId) => this.track(this.drain(() => this.port.approve(stagedId))),
      discard: (stagedId) => this.track(this.drain(() => this.port.discard(stagedId))),
    });
    this.refresh();
  }

  title(): string {
    const notes = this.model.noteCount();
    const staged = this.model.stagedCount();
    const parts = [
      ...(notes === 0 ? [] : [`${notes} ${notes === 1 ? "note" : "notes"}`]),
      ...(staged === 0 ? [] : [`░${staged}`]),
    ];
    return paneTitle("memory", parts.length === 0 ? undefined : parts.join(" · "));
  }

  describe(): PaneDescriptor {
    return { kind: "memory" };
  }

  handleKey(chord: Chord): boolean {
    return this.model.handleKey(chord, this.lastPageRows);
  }

  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  refresh(): void {
    this.track(this.port.load().then((inputs) => this.model.setInputs(inputs)));
  }

  view(context: PaneContext): PaneView {
    const { theme, height, width } = context;
    this.lastPageRows = Math.max(3, height - 3);
    return paneChrome(
      context,
      this.title(),
      ...this.bodyLines(theme, this.lastPageRows, Math.max(10, width - 4)),
    );
  }

  private async drain(act: () => Promise<void>): Promise<void> {
    await act();
    this.model.setInputs(await this.port.load());
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
    return this.model
      .visibleRows(rows)
      .map(({ index, row }) => this.rowLine(row, index === this.model.cursor, theme, width));
  }

  private rowLine(row: MemoryRow, selected: boolean, theme: Theme, width: number) {
    const content = row.text.slice(0, width);
    if (selected && row.selectable) {
      return Text({ content: content.padEnd(width), fg: theme.background, bg: theme.accent });
    }
    return Text({ content, fg: theme[toneToken(row.tone)] });
  }
}
