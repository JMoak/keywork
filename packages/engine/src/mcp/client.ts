import { type ChildProcess, spawn } from "node:child_process";
import { killTree, within } from "../proc.ts";

export const mcpProtocolVersion = "2025-06-18";

const closeGraceMs = 500;
const maxLineChars = 4 * 1024 * 1024;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  text: string;
  isError: boolean;
}

export interface McpConnection {
  serverName: string;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: unknown): Promise<McpToolResult>;
  onClose(handler: (error?: Error) => void): void;
  close(): Promise<void>;
}

export interface StdioServerSpec {
  command: string;
  args?: readonly string[];
  env?: Record<string, string>;
}

export interface StdioConnectOptions {
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}

export class McpAbortedError extends Error {
  constructor() {
    super("connection attempt aborted");
    this.name = "McpAbortedError";
  }
}

export class McpRequestTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`MCP request ${method} timed out after ${timeoutMs}ms`);
    this.name = "McpRequestTimeoutError";
  }
}

export class McpServerExitedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "McpServerExitedError";
  }
}

export class McpProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpProtocolError";
  }
}

export async function connectStdioServer(
  spec: StdioServerSpec,
  options: StdioConnectOptions = {},
): Promise<McpConnection> {
  if (options.signal?.aborted === true) throw new McpAbortedError();
  const channel = new StdioChannel(spec, options.requestTimeoutMs ?? 10_000, options.signal);
  try {
    await channel.handshake();
  } catch (cause) {
    await channel.close().catch(() => undefined);
    throw cause;
  }
  return channel;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

class StdioChannel implements McpConnection {
  serverName = "unknown";
  private readonly child: ChildProcess;
  private readonly timeoutMs: number;
  private readonly exited: Promise<void>;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly closeHandlers: Array<(error?: Error) => void> = [];
  private buffer = "";
  private stderrTail = "";
  private nextId = 1;
  private closed = false;
  private closedDeliberately = false;
  private exitReason: string | undefined;
  private teardown: Promise<void> | undefined;

  constructor(spec: StdioServerSpec, timeoutMs: number, signal?: AbortSignal) {
    this.timeoutMs = timeoutMs;
    this.child = spawn(spec.command, [...(spec.args ?? [])], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...spec.env },
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    this.exited = new Promise((resolve) => {
      this.child.once("exit", () => resolve());
      this.child.once("error", () => resolve());
    });
    this.child.stdin?.on("error", () => {});
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.receive(chunk));
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-400);
    });
    this.child.on("error", (error) => {
      this.settleClosed(new McpServerExitedError(`failed to start server: ${error.message}`));
    });
    this.child.on("exit", (code) => {
      this.settleClosed(new McpServerExitedError(this.describeExit(code)));
    });
    signal?.addEventListener("abort", () => this.abortNow(), { once: true });
  }

  async handshake(): Promise<void> {
    const result = asRecord(
      await this.request("initialize", {
        protocolVersion: mcpProtocolVersion,
        capabilities: {},
        clientInfo: { name: "keywork", version: "0.0.1" },
      }),
    );
    this.serverName = readServerName(result);
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = asRecord(
        await this.request("tools/list", cursor === undefined ? {} : { cursor }),
      );
      for (const entry of asArray(page.tools)) tools.push(readTool(entry));
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
    } while (cursor !== undefined);
    return tools;
  }

  async callTool(name: string, args: unknown): Promise<McpToolResult> {
    const result = asRecord(await this.request("tools/call", { name, arguments: args ?? {} }));
    return { text: renderContent(result.content), isError: result.isError === true };
  }

  onClose(handler: (error?: Error) => void): void {
    this.closeHandlers.push(handler);
  }

  close(): Promise<void> {
    this.closedDeliberately = true;
    this.teardown ??= this.retire();
    return this.teardown;
  }

  private async retire(): Promise<void> {
    this.child.stdin?.end();
    if (await within(this.exited, closeGraceMs)) return;
    await killTree(this.child, this.exited);
  }

  private abortNow(): void {
    this.closedDeliberately = true;
    this.settleClosed(new McpAbortedError());
    this.teardown ??= killTree(this.child, this.exited);
    void this.teardown.catch(() => undefined);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new McpServerExitedError(this.exitReason ?? "server is not running"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpRequestTimeoutError(method, this.timeoutMs));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private send(message: Record<string, unknown>): void {
    if (this.closed) return;
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private receive(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.dispatchLine(line);
      newline = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > maxLineChars) this.rejectFlood();
  }

  private rejectFlood(): void {
    this.buffer = "";
    this.settleClosed(
      new McpProtocolError(`server sent over ${maxLineChars} characters without a newline`),
    );
    this.teardown ??= killTree(this.child, this.exited);
    void this.teardown.catch(() => undefined);
  }

  private dispatchLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    this.dispatch(message as Record<string, unknown>);
  }

  private dispatch(message: Record<string, unknown>): void {
    if (typeof message.method === "string") {
      if (message.id !== undefined && message.id !== null) {
        this.send({
          jsonrpc: "2.0",
          id: message.id as number | string,
          error: { code: -32601, message: "method not supported" },
        });
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const request = this.pending.get(message.id);
    if (request === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(request.timer);
    const failure = asRecord(message.error ?? undefined);
    if (message.error !== undefined) {
      request.reject(new McpProtocolError(String(failure.message ?? "server returned an error")));
      return;
    }
    request.resolve(message.result);
  }

  private settleClosed(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.exitReason = error.message;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    const reported = this.closedDeliberately ? undefined : error;
    for (const handler of this.closeHandlers) handler(reported);
  }

  private describeExit(code: number | null): string {
    const detail = this.stderrTail.trim();
    const base = `server exited (code ${code ?? "unknown"})`;
    return detail.length > 0 ? `${base}: ${detail}` : base;
  }
}

function readServerName(initializeResult: Record<string, unknown>): string {
  const info = asRecord(initializeResult.serverInfo);
  return typeof info.name === "string" ? info.name : "unknown";
}

function readTool(entry: unknown): McpTool {
  const record = asRecord(entry);
  if (typeof record.name !== "string" || record.name.length === 0) {
    throw new McpProtocolError("server listed a tool without a name");
  }
  return {
    name: record.name,
    description: typeof record.description === "string" ? record.description : "",
    inputSchema: asRecord(record.inputSchema ?? { type: "object" }),
  };
}

function renderContent(content: unknown): string {
  return asArray(content)
    .map((block) => {
      const record = asRecord(block);
      if (record.type === "text" && typeof record.text === "string") return record.text;
      return JSON.stringify(record);
    })
    .join("\n");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
