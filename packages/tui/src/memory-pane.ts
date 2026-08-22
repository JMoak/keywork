import type { Chord } from "./keys.ts";
import { type MemoryPaneInputs, MemoryPaneModel } from "./memory-pane-model.ts";
import type { Pane, PaneContext, PaneDescriptor, PaneView } from "./pane.ts";
import {
  type PaneChild,
  paneChrome,
  paneContentHeight,
  paneContentWidth,
  paneFailureLine,
  paneLine,
  paneTitle,
  rowsView,
  toneInk,
} from "./pane-chrome.ts";
import { PaneTasks } from "./pane-tasks.ts";
import { pluralize } from "./pluralize.ts";
import type { Theme } from "./theme.ts";

export interface MemoryPanePort {
  load(): Promise<MemoryPaneInputs>;
  approve(id: string): Promise<void>;
  discard(id: string): Promise<void>;
}

export class MemoryPane implements Pane {
  readonly model: MemoryPaneModel;
  private readonly tasks: PaneTasks;
  private lastPageRows = 20;

  constructor(
    readonly id: string,
    notify: () => void,
    private readonly port: MemoryPanePort,
  ) {
    this.tasks = new PaneTasks(notify);
    this.model = new MemoryPaneModel(() => this.tasks.emit(), {
      refresh: () => this.refresh(),
      approve: (stagedId) => this.tasks.track(() => this.drain(() => this.port.approve(stagedId))),
      discard: (stagedId) => this.tasks.track(() => this.drain(() => this.port.discard(stagedId))),
    });
    this.refresh();
  }

  dispose(): void {
    this.tasks.dispose();
  }

  title(): string {
    const notes = this.model.noteCount();
    const staged = this.model.stagedCount();
    const parts = [
      ...(notes === 0 ? [] : [pluralize(notes, "note")]),
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

  settled(): Promise<void> {
    return this.tasks.settled();
  }

  refresh(): void {
    this.tasks.track(() => this.port.load().then((inputs) => this.model.setInputs(inputs)));
  }

  view(context: PaneContext): PaneView {
    const { theme, height, width } = context;
    this.lastPageRows = paneContentHeight(height);
    return paneChrome(
      context,
      this.title(),
      ...this.bodyLines(theme, this.lastPageRows, paneContentWidth(width)),
    );
  }

  private async drain(act: () => Promise<void>): Promise<void> {
    await act();
    if (!this.tasks.live()) return;
    this.model.setInputs(await this.port.load());
  }

  private bodyLines(theme: Theme, rows: number, width: number): PaneChild[] {
    const failure = this.tasks.failure();
    if (failure !== undefined) return [paneFailureLine(failure, theme, width)];
    return rowsView(this.model, rows, theme, width, {
      text: (row) => row.text,
      line: (row) => paneLine(row.text, toneInk(theme, row.tone), width),
    });
  }
}
