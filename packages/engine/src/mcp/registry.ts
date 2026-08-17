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

export class McpRegistryClosedError extends Error {
  constructor() {
    super("MCP registry has been stopped");
    this.name = "McpRegistryClosedError";
  }
}

export interface McpRegistryOptions {
  servers: Record<string, McpServerConfig>;
  connect?: (spec: StdioServerSpec, signal: AbortSignal) => Promise<McpConnection>;
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
  private readonly connect: (spec: StdioServerSpec, signal: AbortSignal) => Promise<McpConnection>;
  private readonly restartDelays: readonly number[];
  private readonly maxResultChars: number;
  private readonly onToolResult: ((report: McpToolCallReport) => void) | undefined;
  private readonly searchTool: Tool;
  private readonly surfaces = new Map<Tool[], readonly Tool[]>();
  private closing = false;

  constructor(options: McpRegistryOptions) {
    const timeoutMs = options.requestTimeoutMs ?? 10_000;
    this.connect =
      options.connect ??
      ((spec, signal) => connectStdioServer(spec, { requestTimeoutMs: timeoutMs, signal }));
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
    if (this.closing) return;
    for (const runtime of this.runtimes.values()) {
      if (runtime.desired.enabled) this.spawn(runtime);
    }
  }

  async stop(): Promise<void> {
    this.closing = true;
    for (const runtime of this.runtimes.values()) {
      runtime.attempt?.abort();
      runtime.wake.fire();
    }
    const drained = new Set<Promise<void>>();
    for (
      let loops = this.undrainedLoops(drained);
      loops.length > 0;
      loops = this.undrainedLoops(drained)
    ) {
      await Promise.all(loops);
      for (const loop of loops) drained.add(loop);
    }
  }

  private undrainedLoops(drained: ReadonlySet<Promise<void>>): Promise<void>[] {
    return [...this.runtimes.values()]
      .map((runtime) => runtime.loop)
      .filter((loop): loop is Promise<void> => loop !== undefined && !drained.has(loop));
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
      enabled: runtime.desired.enabled,
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
    if (!this.closing && runtime.desired.enabled && runtime.state !== "down") {
      return Promise.resolve();
    }
    return this.transition(runtime, { enabled: true });
  }

  disable(name: string): Promise<void> {
    return this.transition(this.runtime(name), { enabled: false });
  }

  restart(name: string): Promise<void> {
    return this.transition(this.runtime(name), { enabled: true, freshConnection: true });
  }

  listTools(name: string): McpTool[] {
    return [...this.runtime(name).catalog];
  }

  private runtime(name: string): ServerRuntime {
    const runtime = this.runtimes.get(name);
    if (runtime === undefined) throw new McpServerNotFoundError(name);
    return runtime;
  }

  private transition(
    runtime: ServerRuntime,
    change: { enabled: boolean; freshConnection?: boolean },
  ): Promise<void> {
    if (this.closing) return Promise.reject(new McpRegistryClosedError());
    runtime.desired = {
      enabled: change.enabled,
      epoch: runtime.desired.epoch + (change.freshConnection === true ? 1 : 0),
      version: runtime.desired.version + 1,
    };
    runtime.restartAttempt = 0;
    runtime.retriesExhausted = false;
    runtime.eager = true;
    this.spawn(runtime);
    runtime.attempt?.abort();
    runtime.wake.fire();
    return this.settledAt(runtime, runtime.desired.version);
  }

  private spawn(runtime: ServerRuntime): void {
    if (runtime.serving) return;
    runtime.serving = true;
    runtime.loop = this.serve(runtime);
  }

  private async serve(runtime: ServerRuntime): Promise<void> {
    while (!this.closing) {
      const goal = runtime.desired;
      if (this.aligned(runtime, goal)) {
        if (!goal.enabled) this.presentDisabled(runtime);
        this.settle(runtime, goal.version);
        await runtime.wake.wait();
      } else {
        await this.alignOnce(runtime, goal);
      }
    }
    await this.dropConnection(runtime);
    this.settle(runtime, runtime.desired.version);
  }

  private aligned(runtime: ServerRuntime, goal: DesiredState): boolean {
    if (runtime.connection !== undefined) {
      return goal.enabled && !runtime.lost && runtime.connectionEpoch === goal.epoch;
    }
    return !goal.enabled || runtime.retriesExhausted;
  }

  private async alignOnce(runtime: ServerRuntime, goal: DesiredState): Promise<void> {
    if (runtime.connection !== undefined) return this.dropConnection(runtime);
    if (!runtime.eager) {
      const delay = this.restartDelays[runtime.restartAttempt];
      if (delay === undefined) return this.markRetriesExhausted(runtime, goal.version);
      runtime.restartAttempt += 1;
      await runtime.wake.wait(delay);
      if (this.superseded(runtime, goal)) return;
    }
    await this.attemptConnect(runtime, goal);
  }

  private async attemptConnect(runtime: ServerRuntime, goal: DesiredState): Promise<void> {
    runtime.eager = false;
    runtime.state = "connecting";
    this.notify();
    const attempt = new AbortController();
    runtime.attempt = attempt;
    try {
      const opened = await this.openConnection(runtime, attempt.signal);
      if (this.superseded(runtime, goal)) {
        await closeQuietly(opened.connection);
        return;
      }
      this.adopt(runtime, goal, opened);
    } catch (cause) {
      if (this.superseded(runtime, goal)) return;
      runtime.state = "down";
      runtime.lastError = errorMessage(cause);
      this.notify();
      this.settle(runtime, goal.version);
    } finally {
      runtime.attempt = undefined;
    }
  }

  private async openConnection(runtime: ServerRuntime, signal: AbortSignal): Promise<OpenedServer> {
    const connection = await this.connect(stdioSpec(runtime.config), signal);
    try {
      return { connection, catalog: await connection.listTools() };
    } catch (cause) {
      await closeQuietly(connection);
      throw cause;
    }
  }

  private adopt(runtime: ServerRuntime, goal: DesiredState, opened: OpenedServer): void {
    runtime.connection = opened.connection;
    runtime.connectionEpoch = goal.epoch;
    runtime.lost = false;
    runtime.catalog = opened.catalog;
    runtime.state = "connected";
    runtime.lastError = undefined;
    runtime.restartAttempt = 0;
    opened.connection.onClose((error) => this.handleLoss(runtime, opened.connection, error));
    this.rebuildTools();
    this.notify();
    this.settle(runtime, goal.version);
  }

  private async dropConnection(runtime: ServerRuntime): Promise<void> {
    const connection = runtime.connection;
    if (connection === undefined) return;
    runtime.connection = undefined;
    runtime.lastError = runtime.lost ? runtime.lastError : undefined;
    runtime.lost = false;
    runtime.state = "down";
    runtime.catalog = [];
    this.rebuildTools();
    this.notify();
    await closeQuietly(connection);
  }

  private handleLoss(
    runtime: ServerRuntime,
    connection: McpConnection,
    error: Error | undefined,
  ): void {
    if (runtime.connection !== connection) return;
    runtime.lost = true;
    runtime.state = "down";
    runtime.catalog = [];
    runtime.lastError = error?.message ?? "server closed the connection";
    this.rebuildTools();
    this.notify();
    runtime.wake.fire();
  }

  private presentDisabled(runtime: ServerRuntime): void {
    const presented =
      runtime.state === "down" && runtime.lastError === undefined && runtime.catalog.length === 0;
    if (presented) return;
    runtime.state = "down";
    runtime.lastError = undefined;
    runtime.catalog = [];
    this.rebuildTools();
    this.notify();
  }

  private markRetriesExhausted(runtime: ServerRuntime, version: number): void {
    runtime.retriesExhausted = true;
    runtime.lastError = `${runtime.lastError ?? "down"} — retry limit reached, restart manually`;
    this.notify();
    this.settle(runtime, version);
  }

  private superseded(runtime: ServerRuntime, goal: DesiredState): boolean {
    return this.closing || runtime.desired.version !== goal.version;
  }

  private settle(runtime: ServerRuntime, version: number): void {
    if (version <= runtime.settledVersion) return;
    runtime.settledVersion = version;
    const remaining: SettleWaiter[] = [];
    for (const waiter of runtime.waiters) {
      if (waiter.version <= version) waiter.resolve();
      else remaining.push(waiter);
    }
    runtime.waiters = remaining;
  }

  private settledAt(runtime: ServerRuntime, version: number): Promise<void> {
    if (runtime.settledVersion >= version) return Promise.resolve();
    return new Promise((resolve) => runtime.waiters.push({ version, resolve }));
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
      if (!runtime.desired.enabled || runtime.state !== "connected") continue;
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
    if (!runtime.desired.enabled || runtime.state !== "connected" || connection === undefined) {
      throw new Error(
        `MCP server ${runtime.name} is ${runtime.desired.enabled ? runtime.state : "disabled"}`,
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
    for (const listener of this.listeners) quarantine(() => listener(snapshot));
  }
}

interface DesiredState {
  enabled: boolean;
  epoch: number;
  version: number;
}

interface SettleWaiter {
  version: number;
  resolve: () => void;
}

interface OpenedServer {
  connection: McpConnection;
  catalog: McpTool[];
}

interface ServerRuntime {
  name: string;
  config: McpServerConfig;
  desired: DesiredState;
  state: McpServerState;
  connection: McpConnection | undefined;
  connectionEpoch: number;
  lost: boolean;
  eager: boolean;
  retriesExhausted: boolean;
  restartAttempt: number;
  catalog: McpTool[];
  activated: Set<string>;
  lastError: string | undefined;
  settledVersion: number;
  waiters: SettleWaiter[];
  wake: Wakeup;
  serving: boolean;
  loop: Promise<void> | undefined;
  attempt: AbortController | undefined;
}

interface CatalogEntry {
  runtime: ServerRuntime;
  tool: McpTool;
  qualified: string;
}

class Wakeup {
  private fired = false;
  private release: (() => void) | undefined;

  fire(): void {
    this.fired = true;
    const release = this.release;
    this.release = undefined;
    release?.();
  }

  wait(timeoutMs?: number): Promise<void> {
    if (this.fired) {
      this.fired = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.release = undefined;
              resolve();
            }, timeoutMs);
      this.release = () => {
        if (timer !== undefined) clearTimeout(timer);
        this.fired = false;
        resolve();
      };
    });
  }
}

function freshRuntime(name: string, config: McpServerConfig): ServerRuntime {
  return {
    name,
    config,
    desired: { enabled: true, epoch: 0, version: 0 },
    state: "down",
    connection: undefined,
    connectionEpoch: -1,
    lost: false,
    eager: true,
    retriesExhausted: false,
    restartAttempt: 0,
    catalog: [],
    activated: new Set(),
    lastError: undefined,
    settledVersion: -1,
    waiters: [],
    wake: new Wakeup(),
    serving: false,
    loop: undefined,
    attempt: undefined,
  };
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

function quarantine(work: () => void): void {
  try {
    work();
  } catch {
    return;
  }
}

async function closeQuietly(connection: McpConnection): Promise<void> {
  try {
    await connection.close();
  } catch {
    return;
  }
}
