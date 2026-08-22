import { clampIndex, clampScroll } from "./clamp.ts";
import type { Chord } from "./keys.ts";
import type { ThemeColorToken } from "./theme.ts";

export type McpServerState = "connected" | "connecting" | "down";

export interface McpProgress {
  stagesDone: number;
  stageCount: number;
}

export interface McpServerView {
  name: string;
  state: McpServerState;
  toolCount: number;
  enabled?: boolean;
  lastError?: string;
  progress?: McpProgress;
}

export interface McpPaneEffects {
  refresh(): void;
  restart(name: string): void;
  setEnabled(name: string, on: boolean): void;
  listTools(name: string): void;
}

export type McpRowTone = "dim" | "normal" | "alert";
export type McpRowKind = "server" | "error" | "action" | "tool" | "tools-status" | "empty";
export type McpAction = "restart" | "toggle" | "tools" | "retry-tools";

export interface McpRow {
  id: string;
  kind: McpRowKind;
  text: string;
  tone: McpRowTone;
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

export function mcpToneToken(tone: McpRowTone): ThemeColorToken {
  return toneTokens[tone];
}

export class McpPaneModel {
  cursor = 0;
  scrollTop = 0;

  private servers: McpServerView[] = [];
  private busyServers = new Set<string>();
  private openMenus = new Set<string>();
  private openTools = new Set<string>();
  private toolsByServer = new Map<string, ToolsState>();
  private anchorId: string | undefined;
  private revision = 0;
  private cachedRows: { revision: number; rows: McpRow[] } | undefined;

  constructor(
    private readonly notify: () => void,
    private readonly effects: McpPaneEffects,
  ) {}

  setServers(servers: McpServerView[]): void {
    this.anchorId = this.rows()[this.cursor]?.id ?? this.anchorId;
    this.servers = servers;
    this.pruneVanished(new Set(servers.map((server) => server.name)));
    this.touch();
    this.reanchor();
    this.notify();
  }

  setBusy(name: string, busy: boolean): void {
    if (busy === this.busyServers.has(name)) return;
    if (busy) this.busyServers.add(name);
    else this.busyServers.delete(name);
    this.touch();
    this.reanchor();
    this.notify();
  }

  isBusy(name: string): boolean {
    return this.busyServers.has(name);
  }

  setTools(name: string, result: McpToolsResult): void {
    if (this.findServer(name) === undefined) return;
    this.anchorId = this.rows()[this.cursor]?.id ?? this.anchorId;
    this.toolsByServer.set(
      name,
      "tools" in result
        ? { kind: "loaded", tools: result.tools }
        : { kind: "failed", error: result.error },
    );
    this.touch();
    this.reanchor();
    this.notify();
  }

  serverCount(): number {
    return this.servers.length;
  }

  counts(): McpStateCounts {
    const counts: McpStateCounts = { connected: 0, connecting: 0, down: 0 };
    for (const server of this.servers) counts[server.state] += 1;
    return counts;
  }

  rows(): McpRow[] {
    if (this.cachedRows?.revision === this.revision) return this.cachedRows.rows;
    const rows =
      this.servers.length === 0
        ? [calmRow()]
        : this.servers.flatMap((server) => this.serverRows(server));
    this.cachedRows = { revision: this.revision, rows };
    return rows;
  }

  visibleRows(rowCount: number): { index: number; row: McpRow }[] {
    const all = this.rows();
    this.cursor = clampIndex(this.cursor, all.length);
    this.scrollTop = clampScroll(this.scrollTop, all.length, rowCount);
    if (this.cursor < this.scrollTop) this.scrollTop = this.cursor;
    if (this.cursor >= this.scrollTop + rowCount) this.scrollTop = this.cursor - rowCount + 1;
    return all
      .slice(this.scrollTop, this.scrollTop + rowCount)
      .map((row, offset) => ({ index: this.scrollTop + offset, row }));
  }

  cursorRow(): McpRow | undefined {
    return this.rows()[clampIndex(this.cursor, this.rows().length)];
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
    const rows = this.rows();
    this.cursor = clampIndex(this.cursor, rows.length);
    switch (chord.name) {
      case "j":
      case "down":
        return this.moveSelection(1, rows);
      case "k":
      case "up":
        return this.moveSelection(-1, rows);
      case "pagedown":
        return this.moveSelection(pageRows, rows);
      case "pageup":
        return this.moveSelection(-pageRows, rows);
      case "enter":
      case "return":
        return this.activate(rows[this.cursor]);
      case "h":
      case "escape":
        return this.collapse(rows);
      case "r":
        this.effects.refresh();
        return true;
      default:
        return false;
    }
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

  private activate(row: McpRow | undefined): boolean {
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
    if (this.openMenus.has(name)) {
      this.openMenus.delete(name);
      this.openTools.delete(name);
    } else {
      this.openMenus.add(name);
    }
    this.anchorId = `server:${name}`;
    this.touch();
    this.reanchor();
    this.notify();
    return true;
  }

  private toggleTools(name: string): boolean {
    if (this.openTools.has(name)) {
      this.openTools.delete(name);
      this.touch();
      this.reanchor();
      this.notify();
      return true;
    }
    this.openTools.add(name);
    const state = this.toolsByServer.get(name);
    if (state === undefined || state.kind === "failed") return this.startToolListing(name);
    this.touch();
    this.reanchor();
    this.notify();
    return true;
  }

  private startToolListing(name: string): boolean {
    this.toolsByServer.set(name, { kind: "loading" });
    this.touch();
    this.reanchor();
    this.notify();
    this.effects.listTools(name);
    return true;
  }

  private collapse(rows: McpRow[]): boolean {
    const owner = rows[this.cursor]?.server;
    if (owner === undefined || !this.openMenus.has(owner)) return true;
    this.openMenus.delete(owner);
    this.openTools.delete(owner);
    this.anchorId = `server:${owner}`;
    this.touch();
    this.reanchor();
    this.notify();
    return true;
  }

  private moveSelection(delta: number, rows: McpRow[]): boolean {
    const selectable = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.selectable);
    if (selectable.length === 0) return true;
    const at = selectable.findIndex(({ index }) => index >= this.cursor);
    const current = at === -1 ? selectable.length - 1 : at;
    const next = clampIndex(current + delta, selectable.length);
    this.cursor = selectable[next]?.index ?? this.cursor;
    this.anchorId = rows[this.cursor]?.id;
    this.notify();
    return true;
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

  private settleOnSelectable(): void {
    const rows = this.rows();
    const at = rows.findIndex((row) => row.selectable);
    this.cursor = at === -1 ? 0 : at;
  }

  private touch(): void {
    this.revision += 1;
    this.cachedRows = undefined;
  }

  private reanchor(): void {
    const rows = this.rows();
    if (rows.length === 0) {
      this.cursor = 0;
      return;
    }
    const found = rows.findIndex((row) => row.id === this.anchorId);
    this.cursor = found >= 0 ? found : clampIndex(this.cursor, rows.length);
    if (!(rows[this.cursor]?.selectable ?? false)) this.settleOnSelectable();
    this.anchorId = rows[this.cursor]?.id ?? this.anchorId;
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
const toneTokens: Record<McpRowTone, ThemeColorToken> = {
  dim: "textDim",
  normal: "text",
  alert: "error",
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
  if (!isOn(server)) return `${stateGlyph("down")} ${name} · off`;
  switch (server.state) {
    case "connected":
      return `${stateGlyph("connected")} ${name} · ${toolPhrase(server.toolCount)}`;
    case "connecting":
      return `${stateGlyph("connecting")} ${name} · ${tileMark(server.progress)} connecting`;
    case "down":
      return `${stateGlyph("down")} ${name} · ▛`;
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
  if (count === 0) return "no tools";
  return `${count} ${count === 1 ? "tool" : "tools"}`;
}

function isOn(server: McpServerView): boolean {
  return server.enabled !== false;
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
