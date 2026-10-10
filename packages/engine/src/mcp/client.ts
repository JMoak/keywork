import { type ChildProcess, spawn } from "node:child_process";
import { killTree, within } from "../proc.ts";
import {
  discoverProbeTimeoutMs,
  type McpEra,
  McpSession,
  signalsToolsChanged,
  subscriptionMethod,
} from "./era.ts";
import {
  McpAbortedError,
  McpProtocolError,
  McpRequestTimeoutError,
  McpRpcError,
  McpServerExitedError,
} from "./errors.ts";

export { type McpEra, mcpLegacyProtocolVersion, mcpProtocolVersion } from "./era.ts";
export {
  McpAbortedError,
  McpInputRequiredError,
  McpProtocolError,
  McpRequestTimeoutError,
  McpRpcError,
  McpServerExitedError,
} from "./errors.ts";

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
  readonly era: McpEra;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: unknown): Promise<McpToolResult>;
  onClose(handler: (error?: Error) => void): void;
  onToolsChanged(handler: () => void): void;
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
  rememberedEra?: McpEra;
  discoverTimeoutMs?: number;
}

export async function connectStdioServer(
  spec: StdioServerSpec,
  options: StdioConnectOptions = {},
): Promise<McpConnection> {
  if (options.signal?.aborted === true) throw new McpAbortedError();
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const discoverTimeoutMs =
    options.discoverTimeoutMs ?? Math.min(discoverProbeTimeoutMs, requestTimeoutMs);
  const channel = new StdioChannel(spec, { requestTimeoutMs, discoverTimeoutMs }, options.signal);
  try {
    await channel.handshake(options.rememberedEra);
  } catch (cause) {
    await channel.close().catch(() => undefined);
    throw cause;
  }
  return channel;
}

interface StdioTimeouts {
  requestTimeoutMs: number;
  discoverTimeoutMs: number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

class StdioChannel implements McpConnection {
  private readonly session: McpSession;
  private readonly child: ChildProcess;
  private readonly timeoutMs: number;
  private readonly exited: Promise<void>;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly closeHandlers: Array<(error?: Error) => void> = [];
  private readonly toolsChangedHandlers: Array<() => void> = [];
  private buffer = "";
  private stderrTail = "";
  private nextId = 1;
  private closed = false;
  private closedDeliberately = false;
  private exitError: Error | undefined;
  private teardown: Promise<void> | undefined;
  private subscriptionId: number | undefined;

  constructor(spec: StdioServerSpec, timeouts: StdioTimeouts, signal?: AbortSignal) {
    this.timeoutMs = timeouts.requestTimeoutMs;
    this.session = new McpSession(
      {
        request: (method, params, timeoutMs) => this.request(method, params, timeoutMs),
        notify: async (method) => this.send({ jsonrpc: "2.0", method }),
      },
      () => this.announceToolsChanged(),
      timeouts.discoverTimeoutMs,
    );
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

  get serverName(): string {
    return this.session.serverName;
  }

  get era(): McpEra {
    return this.session.era;
  }

  async handshake(rememberedEra?: McpEra): Promise<void> {
    await this.session.open(rememberedEra);
    if (this.session.listensForToolChanges) this.listenForToolChanges();
  }

  listTools(): Promise<McpTool[]> {
    return this.session.listTools();
  }

  callTool(name: string, args: unknown): Promise<McpToolResult> {
    return this.session.callTool(name, args);
  }

  onClose(handler: (error?: Error) => void): void {
    this.closeHandlers.push(handler);
  }

  onToolsChanged(handler: () => void): void {
    this.toolsChangedHandlers.push(handler);
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

  private listenForToolChanges(): void {
    const id = this.nextId++;
    this.subscriptionId = id;
    this.send({
      jsonrpc: "2.0",
      id,
      method: subscriptionMethod,
      params: this.session.subscriptionParams(),
    });
  }

  private announceToolsChanged(): void {
    for (const handler of this.toolsChangedHandlers) handler();
  }

  private request(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(this.exitError ?? new McpServerExitedError("server is not running"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpRequestTimeoutError(method, timeoutMs));
      }, timeoutMs);
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
        return;
      }
      if (signalsToolsChanged(message, this.subscriptionId)) this.announceToolsChanged();
      return;
    }
    if (typeof message.id !== "number") return;
    const request = this.pending.get(message.id);
    if (request === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error !== undefined) {
      request.reject(new McpRpcError(message.error));
      return;
    }
    request.resolve(message.result);
  }

  private settleClosed(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.exitError = error;
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
