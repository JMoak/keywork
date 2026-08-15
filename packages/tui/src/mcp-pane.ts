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
import { paneChrome, paneFailureLine, paneTitle } from "./pane-chrome.ts";
import { PaneTasks } from "./pane-tasks.ts";
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
  private readonly tasks: PaneTasks;
  private lastPageRows = 20;
  private readonly unsubscribe: (() => void) | undefined;

  constructor(
    readonly id: string,
    notify: () => void,
    private readonly port: McpPanePort,
  ) {
    this.tasks = new PaneTasks(notify);
    this.model = new McpPaneModel(() => this.tasks.emit(), {
      refresh: () => this.refresh(),
      restart: (name) => this.transition(name, () => this.port.restart(name)),
      setEnabled: (name, on) => this.transition(name, () => this.port.setEnabled(name, on)),
      listTools: (name) => this.tasks.track(() => this.deliverTools(name)),
    });
    this.unsubscribe = port.subscribe?.((servers) => this.model.setServers(servers));
    this.refresh();
  }

  dispose(): void {
    this.tasks.dispose();
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

  settled(): Promise<void> {
    return this.tasks.settled();
  }

  refresh(): void {
    this.tasks.track(() => this.port.load().then((servers) => this.model.setServers(servers)));
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
    this.tasks.track(() => {
      this.model.setBusy(name, true);
      return this.drain(act).finally(() => {
        this.model.setBusy(name, false);
      });
    });
  }

  private async drain(act: () => Promise<void>): Promise<void> {
    await act();
    if (!this.tasks.live()) return;
    this.model.setServers(await this.port.load());
  }

  private bodyLines(theme: Theme, rows: number, width: number) {
    const failure = this.tasks.failure();
    if (failure !== undefined) return [paneFailureLine(failure, theme, width)];
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
