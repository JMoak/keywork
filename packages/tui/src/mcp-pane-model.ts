import type { McpServerState, McpServerStatus } from "@keywork/engine";
import { clampIndex } from "./clamp.ts";
import type { Chord } from "./keys.ts";
import type { RowTone } from "./pane-chrome.ts";
import { pluralize } from "./pluralize.ts";
import { RowCursor } from "./row-cursor.ts";

export type { McpServerState };

export interface McpProgress {
  stagesDone: number;
  stageCount: number;
}

export type McpServerView = Omit<McpServerStatus, "enabled"> & {
  enabled?: boolean;
  progress?: McpProgress;
};

export interface McpPaneEffects {
  refresh(): void;
  restart(name: string): void;
  setEnabled(name: string, on: boolean): void;
  listTools(name: string): void;
}

export type McpRowKind = "server" | "error" | "action" | "tool" | "tools-status" | "empty";
export type McpAction = "restart" | "toggle" | "tools" | "retry-tools";

export interface McpRow {
  id: string;
  kind: McpRowKind;
  text: string;
  tone: RowTone;
  selectable: boolean;
  server?: string;
  action?: McpAction;
}

export type McpToolsResult = { tools: string[] } | { error: string };

export interface McpStateCounts {
  connected: number;
  connecting: number;
  down: number;
}

export function stateGlyph(state: McpServerState): string {
  return stateGlyphs[state];
}

export function tileMark(progress?: McpProgress): string {
  if (progress === undefined || progress.stageCount === 0) return tileFill[0];
  const step = Math.floor((progress.stagesDone / progress.stageCount) * (tileFill.length - 1));
  return tileFill[clampIndex(step, tileFill.length)] ?? tileFill[0];
}

export class McpPaneModel extends RowCursor<McpRow> {
  private servers: McpServerView[] = [];
  private busyServers = new Set<string>();
  private openMenus = new Set<string>();
  private openTools = new Set<string>();
  private toolsByServer = new Map<string, ToolsState>();

  constructor(
    notify: () => void,
    private readonly effects: McpPaneEffects,
  ) {
    super(notify);
  }

  setServers(servers: readonly McpServerView[]): void {
    this.mutate(() => {
      this.servers = [...servers];
      this.pruneVanished(new Set(servers.map((server) => server.name)));
    });
  }

  setBusy(name: string, busy: boolean): void {
    if (busy === this.busyServers.has(name)) return;
    this.mutate(() => {
      if (busy) this.busyServers.add(name);
      else this.busyServers.delete(name);
    });
  }

  setTools(name: string, result: McpToolsResult): void {
    if (this.findServer(name) === undefined) return;
    this.mutate(() => {
      this.toolsByServer.set(
        name,
        "tools" in result
          ? { kind: "loaded", tools: result.tools }
          : { kind: "failed", error: result.error },
      );
    });
  }

  counts(): McpStateCounts {
    const counts: McpStateCounts = { connected: 0, connecting: 0, down: 0 };
    for (const server of this.servers) counts[server.state] += 1;
    return counts;
  }

  cursorServer(): McpServerView | undefined {
    const name = this.cursorRow()?.server;
    return name === undefined ? undefined : this.findServer(name);
  }

  act(action: McpAction): boolean {
    const server = this.cursorServer();
    if (server === undefined) return false;
    if (!this.openMenus.has(server.name)) this.toggleMenu(server.name);
    return this.runAction(server, action);
  }

  handleKey(chord: Chord, pageRows: number): boolean {
    if (chord.shift || chord.ctrl || chord.meta) return false;
    if (this.navigate(chord, pageRows)) return true;
    switch (chord.name) {
      case "enter":
      case "return":
        return this.activate();
      case "h":
      case "escape":
        return this.collapse();
      case "r":
        this.effects.refresh();
        return true;
      default:
        return false;
    }
  }

  protected buildRows(): McpRow[] {
    if (this.servers.length === 0) return [calmRow()];
    return this.servers.flatMap((server) => this.serverRows(server));
  }

  protected keyOf(row: McpRow): string {
    return row.id;
  }

  protected override selectable(row: McpRow): boolean {
    return row.selectable;
  }

  private serverRows(server: McpServerView): McpRow[] {
    const rows: McpRow[] = [
      {
        id: `server:${server.name}`,
        kind: "server",
        text: serverText(server),
        tone: isOn(server) ? "normal" : "dim",
        selectable: true,
        server: server.name,
      },
    ];
    if (server.state === "down" && server.lastError !== undefined) {
      rows.push({
        id: `error:${server.name}`,
        kind: "error",
        text: `  ${clip(server.lastError, errorLimit)}`,
        tone: "dim",
        selectable: false,
      });
    }
    if (this.openMenus.has(server.name)) rows.push(...this.menuRows(server));
    return rows;
  }

  private menuRows(server: McpServerView): McpRow[] {
    const held = this.busyServers.has(server.name);
    const rows = [
      actionRow(server.name, "restart", "restart", held),
      actionRow(server.name, "toggle", isOn(server) ? "disable" : "enable", held),
      actionRow(server.name, "tools", "tools", false),
    ];
    if (this.openTools.has(server.name)) rows.push(...this.toolRows(server.name));
    return rows;
  }

  private toolRows(name: string): McpRow[] {
    const state = this.toolsByServer.get(name);
    if (state === undefined || state.kind === "loading") {
      return [
        {
          id: `tools:${name}:loading`,
          kind: "tools-status",
          text: `    ${tileMark()} listing tools`,
          tone: "dim",
          selectable: false,
        },
      ];
    }
    if (state.kind === "failed") {
      return [
        {
          id: `tools:${name}:failed`,
          kind: "tools-status",
          text: `    ▛ tools failed · ${clip(state.error, errorLimit)}`,
          tone: "alert",
          selectable: true,
          server: name,
          action: "retry-tools",
        },
      ];
    }
    if (state.tools.length === 0) {
      return [
        {
          id: `tools:${name}:none`,
          kind: "tools-status",
          text: "    no tools",
          tone: "dim",
          selectable: false,
        },
      ];
    }
    return state.tools.map((tool) => ({
      id: `tool:${name}:${tool}`,
      kind: "tool",
      text: `    ${clip(tool, nameLimit)}`,
      tone: "normal",
      selectable: true,
      server: name,
    }));
  }

  private activate(): boolean {
    const row = this.cursorRow();
    if (row?.server === undefined) return true;
    const server = this.findServer(row.server);
    if (server === undefined) return true;
    if (row.kind === "server") return this.toggleMenu(server.name);
    return this.runAction(server, row.action);
  }

  private runAction(server: McpServerView, action: McpAction | undefined): boolean {
    switch (action) {
      case "restart":
        if (!this.busyServers.has(server.name)) this.effects.restart(server.name);
        return true;
      case "toggle":
        if (!this.busyServers.has(server.name)) this.effects.setEnabled(server.name, !isOn(server));
        return true;
      case "tools":
        return this.toggleTools(server.name);
      case "retry-tools":
        return this.startToolListing(server.name);
      default:
        return true;
    }
  }

  private toggleMenu(name: string): boolean {
    return this.mutate(() => {
      if (this.openMenus.has(name)) {
        this.openMenus.delete(name);
        this.openTools.delete(name);
      } else {
        this.openMenus.add(name);
      }
    }, `server:${name}`);
  }

  private toggleTools(name: string): boolean {
    if (this.openTools.has(name)) return this.mutate(() => this.openTools.delete(name));
    if (this.toolsByServer.get(name)?.kind === "loaded") {
      return this.mutate(() => this.openTools.add(name));
    }
    this.openTools.add(name);
    return this.startToolListing(name);
  }

  private startToolListing(name: string): boolean {
    this.mutate(() => this.toolsByServer.set(name, { kind: "loading" }));
    this.effects.listTools(name);
    return true;
  }

  private collapse(): boolean {
    const owner = this.cursorRow()?.server;
    if (owner === undefined || !this.openMenus.has(owner)) return true;
    return this.mutate(() => {
      this.openMenus.delete(owner);
      this.openTools.delete(owner);
    }, `server:${owner}`);
  }

  private findServer(name: string): McpServerView | undefined {
    return this.servers.find((server) => server.name === name);
  }

  private pruneVanished(names: Set<string>): void {
    for (const name of this.busyServers) if (!names.has(name)) this.busyServers.delete(name);
    for (const name of this.openMenus) if (!names.has(name)) this.openMenus.delete(name);
    for (const name of this.openTools) if (!names.has(name)) this.openTools.delete(name);
    for (const name of this.toolsByServer.keys())
      if (!names.has(name)) this.toolsByServer.delete(name);
  }
}

type ToolsState =
  | { kind: "loading" }
  | { kind: "loaded"; tools: string[] }
  | { kind: "failed"; error: string };

const stateGlyphs: Record<McpServerState, string> = {
  connected: "█",
  connecting: "▒",
  down: "░",
};
const tileFill = ["▌", "▌▀", "▌▀▗", "█"] as const;
const nameLimit = 32;
const errorLimit = 48;

function calmRow(): McpRow {
  return {
    id: "calm",
    kind: "empty",
    text: "no mcp servers configured",
    tone: "dim",
    selectable: false,
  };
}

function serverText(server: McpServerView): string {
  const name = clip(server.name, nameLimit);
  const via = server.transport === "http" ? " · http" : "";
  if (!isOn(server)) return `${stateGlyph("down")} ${name} · off${via}`;
  switch (server.state) {
    case "connected":
      return `${stateGlyph("connected")} ${name} · ${toolPhrase(server.toolCount)}${via}`;
    case "connecting":
      return `${stateGlyph("connecting")} ${name} · ${tileMark(server.progress)} connecting${via}`;
    case "down":
      return `${stateGlyph("down")} ${name} · ▛${via}`;
  }
}

function actionRow(name: string, action: McpAction, label: string, held: boolean): McpRow {
  return {
    id: `menu:${name}:${action}`,
    kind: "action",
    text: `  ${label}`,
    tone: held ? "dim" : "normal",
    selectable: true,
    server: name,
    action,
  };
}

function toolPhrase(count: number): string {
  return count === 0 ? "no tools" : pluralize(count, "tool");
}

function isOn(server: McpServerView): boolean {
  return server.enabled !== false;
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
