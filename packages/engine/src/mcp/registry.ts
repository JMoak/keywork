import type { McpServerConfig } from "@keywork/shared";
import type { ToolSource } from "../agent.ts";
import type { Tool } from "../tools.ts";
import { connectStdioServer, type McpTool } from "./client.ts";
import {
  type ConnectServer,
  type McpServerStatus,
  ServerReconciler,
  type ServerTransition,
} from "./reconciler.ts";
import { type CatalogEntry, mcpToolSearch } from "./tool-search.ts";

export type McpStatusListener = (statuses: McpServerStatus[]) => void;

export interface McpToolCallReport {
  server: string;
  tool: string;
  external: boolean;
}

export interface McpToolProvenance {
  server: string;
  trusted: boolean;
}

export interface McpBackedTool extends Tool {
  mcp: McpToolProvenance;
}

export function isMcpBackedTool(tool: Tool): tool is McpBackedTool {
  return "mcp" in tool;
}

export class McpServerNotFoundError extends Error {
  constructor(name: string) {
    super(`unknown MCP server: ${name}`);
    this.name = "McpServerNotFoundError";
  }
}

export class McpRegistryClosedError extends Error {
  constructor() {
    super("MCP registry has been stopped");
    this.name = "McpRegistryClosedError";
  }
}

export interface McpRegistryOptions {
  servers: Record<string, McpServerConfig>;
  connect?: ConnectServer;
  requestTimeoutMs?: number;
  restartDelaysMs?: readonly number[];
  maxResultChars?: number;
  onToolResult?: (report: McpToolCallReport) => void;
}

export const defaultRestartDelaysMs: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000];

export class McpRegistry {
  private readonly servers = new Map<string, ServerReconciler>();
  private readonly listeners = new Set<McpStatusListener>();
  private readonly activated = new Set<string>();
  private readonly maxResultChars: number;
  private readonly onToolResult: ((report: McpToolCallReport) => void) | undefined;
  private readonly searchTool: Tool;
  private live: readonly Tool[] = [];
  private closing = false;

  constructor(options: McpRegistryOptions) {
    const timeoutMs = options.requestTimeoutMs ?? 10_000;
    const connect: ConnectServer =
      options.connect ??
      ((spec, signal) => connectStdioServer(spec, { requestTimeoutMs: timeoutMs, signal }));
    const restartDelays = options.restartDelaysMs ?? defaultRestartDelaysMs;
    this.maxResultChars = options.maxResultChars ?? 30_000;
    this.onToolResult = options.onToolResult;
    this.searchTool = mcpToolSearch({
      catalog: () => this.catalog(),
      activate: (names) => this.activate(names),
    });
    for (const [name, config] of Object.entries(options.servers)) {
      this.servers.set(
        name,
        new ServerReconciler({
          name,
          config,
          connect,
          restartDelays,
          onChange: () => this.refresh(),
        }),
      );
    }
    this.rebuildTools();
  }

  start(): void {
    if (this.closing) return;
    for (const server of this.servers.values()) server.start();
  }

  async stop(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.servers.values()].map((server) => server.stop()));
  }

  tools(): readonly Tool[] {
    return this.live;
  }

  surface(base: readonly Tool[]): ToolSource {
    return () => [...base, ...this.live];
  }

  status(): McpServerStatus[] {
    return [...this.servers.values()].map((server) => server.status());
  }

  subscribe(listener: McpStatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  enable(name: string): Promise<void> {
    const server = this.server(name);
    if (this.closing) return Promise.reject(new McpRegistryClosedError());
    const { enabled, state } = server.status();
    if (enabled && state !== "down") return server.settled();
    return server.transition({ enabled: true });
  }

  disable(name: string): Promise<void> {
    return this.transition(name, { enabled: false });
  }

  restart(name: string): Promise<void> {
    return this.transition(name, { enabled: true, freshConnection: true });
  }

  listTools(name: string): McpTool[] {
    return [...this.server(name).listedTools()];
  }

  private server(name: string): ServerReconciler {
    const server = this.servers.get(name);
    if (server === undefined) throw new McpServerNotFoundError(name);
    return server;
  }

  private transition(name: string, change: ServerTransition): Promise<void> {
    const server = this.server(name);
    if (this.closing) return Promise.reject(new McpRegistryClosedError());
    return server.transition(change);
  }

  private refresh(): void {
    this.rebuildTools();
    this.notify();
  }

  private activate(qualifiedNames: readonly string[]): void {
    for (const name of qualifiedNames) this.activated.add(name);
    this.rebuildTools();
  }

  private rebuildTools(): void {
    this.live = this.servers.size === 0 ? [] : [this.searchTool, ...this.activatedTools()];
  }

  private activatedTools(): McpBackedTool[] {
    return this.catalog()
      .filter((entry) => this.activated.has(entry.qualified))
      .map((entry) => this.backedTool(entry));
  }

  private catalog(): ServerCatalogEntry[] {
    const entries: ServerCatalogEntry[] = [];
    for (const server of this.servers.values()) {
      for (const tool of server.live()?.catalog ?? []) {
        entries.push({ server, tool, qualified: qualifiedName(server.name, tool.name) });
      }
    }
    return entries;
  }

  private backedTool({ server, tool, qualified }: ServerCatalogEntry): McpBackedTool {
    return {
      name: qualified,
      description: tool.description,
      parameters: tool.inputSchema,
      mutates: true,
      mcp: { server: server.name, trusted: server.config.trusted === true },
      execute: (args) => this.invoke(server, tool.name, args),
    };
  }

  private async invoke(server: ServerReconciler, toolName: string, args: unknown): Promise<string> {
    const live = server.live();
    if (live === undefined) {
      const { enabled, state } = server.status();
      throw new Error(`MCP server ${server.name} is ${enabled ? state : "disabled"}`);
    }
    const report = {
      server: server.name,
      tool: toolName,
      external: server.config.trusted !== true,
    };
    try {
      const result = await live.connection.callTool(toolName, args);
      const text = truncate(result.text, this.maxResultChars);
      if (result.isError) throw new Error(text);
      return text;
    } finally {
      this.onToolResult?.(report);
    }
  }

  private notify(): void {
    const snapshot = this.status();
    for (const listener of this.listeners) quarantine(() => listener(snapshot));
  }
}

interface ServerCatalogEntry extends CatalogEntry {
  server: ServerReconciler;
}

function qualifiedName(server: string, tool: string): string {
  return `${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} characters]`;
}

function quarantine(work: () => void): void {
  try {
    work();
  } catch {
    return;
  }
}
