import { Text } from "@opentui/core";
import type { Chord } from "./keys.ts";
import {
  McpPaneModel,
  type McpRow,
  type McpServerView,
  mcpToneToken,
  stateGlyph,
} from "./mcp-pane-model.ts";
import type { Pane, PaneContext, PaneDescriptor, PaneView } from "./pane.ts";
import { paneChrome, paneTitle } from "./pane-chrome.ts";
import type { Theme } from "./theme.ts";

export interface McpPanePort {
  load(): Promise<McpServerView[]>;
  restart(name: string): Promise<void>;
  setEnabled(name: string, on: boolean): Promise<void>;
  listTools(name: string): Promise<string[]>;
  subscribe?(listener: (servers: McpServerView[]) => void): () => void;
}

export function mcpDropWatcher(
  notice: (text: string) => void,
): (servers: readonly McpServerView[]) => void {
  const lastStates = new Map<string, McpServerView["state"]>();
  return (servers) => {
    for (const server of servers) {
      if (lastStates.get(server.name) === "connected" && server.state === "down") {
        notice(`mcp: ${server.name} went down`);
      }
      lastStates.set(server.name, server.state);
    }
  };
}

export class McpPane implements Pane {
  readonly model: McpPaneModel;
  private failure: string | undefined;
  private readonly pending = new Set<Promise<void>>();
  private lastPageRows = 20;
  private readonly unsubscribe: (() => void) | undefined;

  constructor(
    readonly id: string,
    private readonly notify: () => void,
    private readonly port: McpPanePort,
  ) {
    this.model = new McpPaneModel(notify, {
      refresh: () => this.refresh(),
      restart: (name) => this.transition(name, () => this.port.restart(name)),
      setEnabled: (name, on) => this.transition(name, () => this.port.setEnabled(name, on)),
      listTools: (name) => this.track(this.deliverTools(name)),
    });
    this.unsubscribe = port.subscribe?.((servers) => this.model.setServers(servers));
    this.refresh();
  }

  dispose(): void {
    this.unsubscribe?.();
  }

  title(): string {
    const counts = this.model.counts();
    const parts = (["connected", "connecting", "down"] as const)
      .filter((state) => counts[state] > 0)
      .map((state) => `${stateGlyph(state)}${counts[state]}`);
    return paneTitle("mcp", parts.length === 0 ? undefined : parts.join(" "));
  }

  describe(): PaneDescriptor {
    return { kind: "mcp" };
  }

  handleKey(chord: Chord): boolean {
    return this.model.handleKey(chord, this.lastPageRows);
  }

  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  refresh(): void {
    this.track(this.port.load().then((servers) => this.model.setServers(servers)));
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

  private async deliverTools(name: string): Promise<void> {
    try {
      this.model.setTools(name, { tools: await this.port.listTools(name) });
    } catch (cause: unknown) {
      this.model.setTools(name, { error: (cause as Error).message });
    }
  }

  private transition(name: string, act: () => Promise<void>): void {
    this.model.setBusy(name, true);
    this.track(
      this.drain(act).finally(() => {
        this.model.setBusy(name, false);
      }),
    );
  }

  private async drain(act: () => Promise<void>): Promise<void> {
    await act();
    this.model.setServers(await this.port.load());
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

  private rowLine(row: McpRow, selected: boolean, theme: Theme, width: number) {
    const content = row.text.slice(0, width);
    if (selected && row.selectable) {
      return Text({ content: content.padEnd(width), fg: theme.background, bg: theme.accent });
    }
    return Text({ content, fg: theme[mcpToneToken(row.tone)] });
  }
}
