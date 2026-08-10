import type { McpServerConfig } from "@keywork/shared";
import { z } from "zod";
import type { Tool } from "../tools.ts";
import {
  connectStdioServer,
  type McpConnection,
  type McpTool,
  type StdioServerSpec,
} from "./client.ts";

export type McpServerState = "connected" | "connecting" | "down";

export interface McpServerStatus {
  name: string;
  state: McpServerState;
  enabled: boolean;
  toolCount: number;
  lastError?: string;
}

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

export interface McpRegistryOptions {
  servers: Record<string, McpServerConfig>;
  connect?: (spec: StdioServerSpec) => Promise<McpConnection>;
  requestTimeoutMs?: number;
  restartDelaysMs?: readonly number[];
  maxResultChars?: number;
  onToolResult?: (report: McpToolCallReport) => void;
}

export const defaultRestartDelaysMs: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000];
export const mcpSearchToolName = "mcp_tool_search";

export class McpRegistry {
  private readonly runtimes = new Map<string, ServerRuntime>();
  private readonly live: Tool[] = [];
  private readonly listeners = new Set<McpStatusListener>();
  private readonly connect: (spec: StdioServerSpec) => Promise<McpConnection>;
  private readonly restartDelays: readonly number[];
  private readonly maxResultChars: number;
  private readonly onToolResult: ((report: McpToolCallReport) => void) | undefined;
  private readonly searchTool: Tool;
  private readonly surfaces = new Map<Tool[], readonly Tool[]>();
  private disposed = false;

  constructor(options: McpRegistryOptions) {
    const timeoutMs = options.requestTimeoutMs ?? 10_000;
    this.connect =
      options.connect ?? ((spec) => connectStdioServer(spec, { requestTimeoutMs: timeoutMs }));
    this.restartDelays = options.restartDelaysMs ?? defaultRestartDelaysMs;
    this.maxResultChars = options.maxResultChars ?? 30_000;
    this.onToolResult = options.onToolResult;
    this.searchTool = this.buildSearchTool();
    for (const [name, config] of Object.entries(options.servers)) {
      this.runtimes.set(name, freshRuntime(name, config));
    }
    this.rebuildTools();
  }

  start(): void {
    for (const runtime of this.runtimes.values()) {
      if (runtime.enabled) void this.connectServer(runtime);
    }
  }

  async stop(): Promise<void> {
    this.disposed = true;
    const closing: Promise<void>[] = [];
    for (const runtime of this.runtimes.values()) {
      runtime.generation += 1;
      clearRetry(runtime);
      if (runtime.connection !== undefined) {
        closing.push(runtime.connection.close());
        runtime.connection = undefined;
      }
      runtime.state = "down";
      runtime.catalog = [];
    }
    this.rebuildTools();
    await Promise.all(closing);
  }

  tools(): readonly Tool[] {
    return this.live;
  }

  surface(base: readonly Tool[]): readonly Tool[] {
    const view: Tool[] = [...base, ...this.live];
    this.surfaces.set(view, base);
    return view;
  }

  dropSurface(view: readonly Tool[]): void {
    this.surfaces.delete(view as Tool[]);
  }

  status(): McpServerStatus[] {
    return [...this.runtimes.values()].map((runtime) => ({
      name: runtime.name,
      state: runtime.state,
      enabled: runtime.enabled,
      toolCount: runtime.catalog.length,
      ...(runtime.lastError !== undefined && { lastError: runtime.lastError }),
    }));
  }

  subscribe(listener: McpStatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  enable(name: string): Promise<void> {
    const runtime = this.runtime(name);
    if (runtime.enabled && runtime.state !== "down") return Promise.resolve();
    runtime.enabled = true;
    runtime.restartAttempt = 0;
    return this.connectServer(runtime);
  }

  disable(name: string): Promise<void> {
    const runtime = this.runtime(name);
    runtime.enabled = false;
    runtime.generation += 1;
    clearRetry(runtime);
    const connection = runtime.connection;
    runtime.connection = undefined;
    runtime.state = "down";
    runtime.catalog = [];
    runtime.lastError = undefined;
    runtime.restartAttempt = 0;
    this.rebuildTools();
    this.notify();
    return connection?.close() ?? Promise.resolve();
  }

  async restart(name: string): Promise<void> {
    const runtime = this.runtime(name);
    runtime.enabled = true;
    runtime.generation += 1;
    clearRetry(runtime);
    const previous = runtime.connection;
    runtime.connection = undefined;
    runtime.restartAttempt = 0;
    await (previous?.close() ?? Promise.resolve());
    await this.connectServer(runtime);
  }

  listTools(name: string): McpTool[] {
    return [...this.runtime(name).catalog];
  }

  private runtime(name: string): ServerRuntime {
    const runtime = this.runtimes.get(name);
    if (runtime === undefined) throw new McpServerNotFoundError(name);
    return runtime;
  }

  private async connectServer(runtime: ServerRuntime): Promise<void> {
    clearRetry(runtime);
    runtime.generation += 1;
    const generation = runtime.generation;
    runtime.state = "connecting";
    this.rebuildTools();
    this.notify();
    try {
      const connection = await this.connect(stdioSpec(runtime.config));
      if (this.stale(runtime, generation)) {
        void connection.close();
        return;
      }
      const catalog = await connection.listTools();
      if (this.stale(runtime, generation)) {
        void connection.close();
        return;
      }
      runtime.connection = connection;
      runtime.catalog = catalog;
      runtime.state = "connected";
      runtime.lastError = undefined;
      runtime.restartAttempt = 0;
      connection.onClose((error) => this.handleConnectionLoss(runtime, generation, error));
    } catch (cause) {
      if (this.stale(runtime, generation)) return;
      runtime.state = "down";
      runtime.lastError = errorMessage(cause);
      this.scheduleRetry(runtime);
    }
    this.rebuildTools();
    this.notify();
  }

  private handleConnectionLoss(
    runtime: ServerRuntime,
    generation: number,
    error: Error | undefined,
  ): void {
    if (this.stale(runtime, generation)) return;
    runtime.generation += 1;
    runtime.connection = undefined;
    runtime.state = "down";
    runtime.catalog = [];
    runtime.lastError = error?.message ?? "server closed the connection";
    this.scheduleRetry(runtime);
    this.rebuildTools();
    this.notify();
  }

  private scheduleRetry(runtime: ServerRuntime): void {
    if (this.disposed || !runtime.enabled) return;
    if (runtime.restartAttempt >= this.restartDelays.length) {
      runtime.lastError = `${runtime.lastError ?? "down"} — retry limit reached, restart manually`;
      return;
    }
    const delay = this.restartDelays[runtime.restartAttempt] ?? 0;
    runtime.restartAttempt += 1;
    runtime.retryTimer = setTimeout(() => {
      runtime.retryTimer = undefined;
      void this.connectServer(runtime);
    }, delay);
  }

  private stale(runtime: ServerRuntime, generation: number): boolean {
    return this.disposed || !runtime.enabled || runtime.generation !== generation;
  }

  private rebuildTools(): void {
    this.live.length = 0;
    if (this.runtimes.size > 0) {
      this.live.push(this.searchTool);
      for (const entry of this.catalogEntries()) {
        if (entry.runtime.activated.has(entry.tool.name)) {
          this.live.push(this.backedTool(entry.runtime, entry.tool));
        }
      }
    }
    for (const [view, base] of this.surfaces) {
      view.length = 0;
      view.push(...base, ...this.live);
    }
  }

  private catalogEntries(): CatalogEntry[] {
    const entries: CatalogEntry[] = [];
    for (const runtime of this.runtimes.values()) {
      if (!runtime.enabled || runtime.state !== "connected") continue;
      for (const tool of runtime.catalog) {
        entries.push({ runtime, tool, qualified: qualifiedName(runtime.name, tool.name) });
      }
    }
    return entries;
  }

  private buildSearchTool(): Tool {
    const registry = this;
    const schema = z.object({
      tools: z.array(z.string()).optional(),
      query: z.string().optional(),
    });
    return {
      name: mcpSearchToolName,
      get description() {
        return registry.searchDescription();
      },
      parameters: z.toJSONSchema(schema),
      execute: async (args) => registry.fetchSchemas(schema.parse(args)),
    };
  }

  private searchDescription(): string {
    const lines = this.catalogEntries().map(
      (entry) => `${entry.qualified} — ${oneLiner(entry.tool.description)}`,
    );
    const roster = lines.length > 0 ? lines.join("\n") : "(no connected servers)";
    return `Fetches full schemas for MCP tools so they become directly callable. Pass exact tool names or a search query.\nAvailable:\n${roster}`;
  }

  private fetchSchemas(args: { tools?: string[] | undefined; query?: string | undefined }): string {
    const entries = this.catalogEntries();
    const matched = new Map<string, CatalogEntry>();
    const missing: string[] = [];
    for (const name of args.tools ?? []) {
      const entry = entries.find((candidate) => candidate.qualified === name);
      if (entry === undefined) missing.push(name);
      else matched.set(entry.qualified, entry);
    }
    if (missing.length > 0) {
      throw new Error(`unknown MCP tools: ${missing.join(", ")}. ${availableSummary(entries)}`);
    }
    if (args.query !== undefined) {
      for (const entry of entries) {
        if (matchesQuery(entry, args.query)) matched.set(entry.qualified, entry);
      }
    }
    if (matched.size === 0) {
      throw new Error(`no MCP tools matched. ${availableSummary(entries)}`);
    }
    for (const entry of matched.values()) entry.runtime.activated.add(entry.tool.name);
    this.rebuildTools();
    const schemas = [...matched.values()].map((entry) => ({
      name: entry.qualified,
      description: entry.tool.description,
      parameters: entry.tool.inputSchema,
    }));
    return `${JSON.stringify(schemas, null, 2)}\nThese tools are now directly callable.`;
  }

  private backedTool(runtime: ServerRuntime, tool: McpTool): McpBackedTool {
    return {
      name: qualifiedName(runtime.name, tool.name),
      description: tool.description,
      parameters: tool.inputSchema,
      mutates: true,
      mcp: { server: runtime.name, trusted: runtime.config.trusted === true },
      execute: (args) => this.invoke(runtime, tool.name, args),
    };
  }

  private async invoke(runtime: ServerRuntime, toolName: string, args: unknown): Promise<string> {
    const connection = runtime.connection;
    if (!runtime.enabled || runtime.state !== "connected" || connection === undefined) {
      throw new Error(
        `MCP server ${runtime.name} is ${runtime.enabled ? runtime.state : "disabled"}`,
      );
    }
    const report = {
      server: runtime.name,
      tool: toolName,
      external: runtime.config.trusted !== true,
    };
    let result: { text: string; isError: boolean };
    try {
      result = await connection.callTool(toolName, args);
    } catch (cause) {
      this.onToolResult?.(report);
      throw cause;
    }
    this.onToolResult?.(report);
    const text = truncate(result.text, this.maxResultChars);
    if (result.isError) throw new Error(text);
    return text;
  }

  private notify(): void {
    const snapshot = this.status();
    for (const listener of this.listeners) listener(snapshot);
  }
}

interface ServerRuntime {
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  state: McpServerState;
  connection: McpConnection | undefined;
  catalog: McpTool[];
  activated: Set<string>;
  lastError: string | undefined;
  restartAttempt: number;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  generation: number;
}

interface CatalogEntry {
  runtime: ServerRuntime;
  tool: McpTool;
  qualified: string;
}

function freshRuntime(name: string, config: McpServerConfig): ServerRuntime {
  return {
    name,
    config,
    enabled: true,
    state: "down",
    connection: undefined,
    catalog: [],
    activated: new Set(),
    lastError: undefined,
    restartAttempt: 0,
    retryTimer: undefined,
    generation: 0,
  };
}

function clearRetry(runtime: ServerRuntime): void {
  if (runtime.retryTimer !== undefined) clearTimeout(runtime.retryTimer);
  runtime.retryTimer = undefined;
}

function stdioSpec(config: McpServerConfig): StdioServerSpec {
  if (config.transport !== "stdio") {
    throw new Error("http MCP transport is not supported yet (arrives with D9)");
  }
  return {
    command: config.command,
    ...(config.args !== undefined && { args: config.args }),
    ...(config.env !== undefined && { env: config.env }),
  };
}

function qualifiedName(server: string, tool: string): string {
  return `${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function oneLiner(description: string): string {
  const firstLine = description.split("\n", 1)[0] ?? "";
  const sentenceEnd = firstLine.indexOf(". ");
  const sentence = sentenceEnd === -1 ? firstLine : firstLine.slice(0, sentenceEnd + 1);
  return sentence.length > 80 ? `${sentence.slice(0, 77)}...` : sentence;
}

function matchesQuery(entry: CatalogEntry, query: string): boolean {
  const haystack = `${entry.qualified} ${entry.tool.description}`.toLowerCase();
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
}

function availableSummary(entries: CatalogEntry[]): string {
  if (entries.length === 0) return "No MCP tools are available.";
  return `Available: ${entries.map((entry) => entry.qualified).join(", ")}`;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} characters]`;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
