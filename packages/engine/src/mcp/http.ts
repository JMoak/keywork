import {
  McpAbortedError,
  type McpConnection,
  McpRequestTimeoutError,
  McpServerExitedError,
  type McpTool,
  type McpToolResult,
} from "./client.ts";
import {
  asRecord,
  collectToolPages,
  initializeParams,
  McpProtocolError,
  mcpProtocolVersion,
  readServerName,
  toolCallResult,
} from "./wire.ts";

export interface HttpServerSpec {
  url: string;
  headers?: Record<string, string>;
}

export interface HttpConnectOptions {
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function connectHttpServer(
  spec: HttpServerSpec,
  options: HttpConnectOptions = {},
): Promise<McpConnection> {
  if (options.signal?.aborted === true) throw new McpAbortedError();
  const channel = new HttpChannel(
    spec,
    options.requestTimeoutMs ?? 10_000,
    options.fetchImpl ?? fetch,
    options.signal,
  );
  try {
    await channel.handshake();
  } catch (cause) {
    await channel.close().catch(() => undefined);
    throw cause;
  }
  return channel;
}

const toolsChangedNotification = "notifications/tools/list_changed";
const maxBodyChars = 16 * 1024 * 1024;

class HttpChannel implements McpConnection {
  serverName = "unknown";
  private readonly spec: HttpServerSpec;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly closeHandlers: Array<(error?: Error) => void> = [];
  private readonly toolsChangedHandlers: Array<() => void> = [];
  private readonly inflight = new Set<AbortController>();
  private sessionId: string | undefined;
  private nextId = 1;
  private closed = false;
  private closedDeliberately = false;
  private exitError: Error | undefined;

  constructor(
    spec: HttpServerSpec,
    timeoutMs: number,
    fetchImpl: typeof fetch,
    signal?: AbortSignal,
  ) {
    this.spec = spec;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    signal?.addEventListener("abort", () => this.abortNow(), { once: true });
  }

  async handshake(): Promise<void> {
    const result = asRecord(await this.request("initialize", initializeParams()));
    this.serverName = readServerName(result);
    await this.notify("notifications/initialized");
    this.openEventStream();
  }

  listTools(): Promise<McpTool[]> {
    return collectToolPages((method, params) => this.request(method, params));
  }

  async callTool(name: string, args: unknown): Promise<McpToolResult> {
    return toolCallResult(
      asRecord(await this.request("tools/call", { name, arguments: args ?? {} })),
    );
  }

  onClose(handler: (error?: Error) => void): void {
    this.closeHandlers.push(handler);
  }

  onToolsChanged(handler: () => void): void {
    this.toolsChangedHandlers.push(handler);
  }

  async close(): Promise<void> {
    this.closedDeliberately = true;
    const session = this.sessionId;
    this.settleClosed(new McpServerExitedError("connection closed"));
    if (session !== undefined) await this.endSession(session);
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) throw this.exitError ?? new McpServerExitedError("connection is closed");
    const id = this.nextId++;
    const message = await this.withTimeout(method, async (signal) => {
      const response = await this.post({ jsonrpc: "2.0", id, method, params }, signal);
      return this.readRpcResponse(response, id, method);
    });
    if (message.error !== undefined) {
      const failure = asRecord(message.error);
      throw new McpProtocolError(String(failure.message ?? "server returned an error"));
    }
    return message.result;
  }

  private async notify(method: string): Promise<void> {
    await this.withTimeout(method, async (signal) => {
      const response = await this.post({ jsonrpc: "2.0", method }, signal);
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok && response.status !== 202) {
        throw new McpProtocolError(`server answered ${response.status} to ${method}`);
      }
    });
  }

  private async post(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    const response = await this.fetchImpl(this.spec.url, {
      method: "POST",
      headers: this.headers({
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      }),
      body: JSON.stringify(body),
      signal,
    });
    const session = response.headers.get("mcp-session-id");
    if (session !== null) this.sessionId = session;
    return response;
  }

  private async readRpcResponse(
    response: Response,
    id: number,
    method: string,
  ): Promise<Record<string, unknown>> {
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpProtocolError(`server answered ${response.status} to ${method}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      return this.responseFromStream(response, id, method);
    }
    const text = await response.text();
    if (text.length > maxBodyChars) {
      throw new McpProtocolError(`server answered ${method} with over ${maxBodyChars} characters`);
    }
    return asRecord(parseJson(text, method));
  }

  private async responseFromStream(
    response: Response,
    id: number,
    method: string,
  ): Promise<Record<string, unknown>> {
    if (response.body === null) {
      throw new McpProtocolError(`server sent an empty event stream for ${method}`);
    }
    for await (const payload of sseData(response.body)) {
      const message = asRecord(parseJson(payload, method));
      if (message.id === id) return message;
      this.dispatchServerMessage(message);
    }
    throw new McpProtocolError(`event stream ended before answering ${method}`);
  }

  private openEventStream(): void {
    const controller = new AbortController();
    this.inflight.add(controller);
    void this.listenForServerEvents(controller).finally(() => this.inflight.delete(controller));
  }

  private async listenForServerEvents(controller: AbortController): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.spec.url, {
        method: "GET",
        headers: this.headers({ accept: "text/event-stream" }),
        signal: controller.signal,
      });
    } catch {
      return;
    }
    if (!response.ok || response.body === null) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    try {
      for await (const payload of sseData(response.body)) {
        this.dispatchServerMessage(asRecord(parseJson(payload, "event stream")));
      }
    } catch {
      this.dropConnection("event stream failed");
      return;
    }
    this.dropConnection("event stream dropped");
  }

  private dispatchServerMessage(message: Record<string, unknown>): void {
    if (message.method !== toolsChangedNotification) return;
    for (const handler of this.toolsChangedHandlers) handler();
  }

  private dropConnection(reason: string): void {
    if (this.closed) return;
    this.settleClosed(new McpServerExitedError(reason));
  }

  private async withTimeout<T>(
    method: string,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    this.inflight.add(controller);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await run(controller.signal);
    } catch (cause) {
      if (this.closed) throw this.exitError ?? new McpServerExitedError("connection is closed");
      if (controller.signal.aborted) throw new McpRequestTimeoutError(method, this.timeoutMs);
      if (cause instanceof McpProtocolError) throw cause;
      throw new McpServerExitedError(`request failed: ${errorMessage(cause)}`);
    } finally {
      clearTimeout(timer);
      this.inflight.delete(controller);
    }
  }

  private headers(base: Record<string, string>): Record<string, string> {
    return {
      ...base,
      "mcp-protocol-version": mcpProtocolVersion,
      ...(this.sessionId !== undefined && { "mcp-session-id": this.sessionId }),
      ...this.spec.headers,
    };
  }

  private abortNow(): void {
    this.closedDeliberately = true;
    this.settleClosed(new McpAbortedError());
  }

  private settleClosed(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.exitError = error;
    for (const controller of this.inflight) controller.abort();
    const reported = this.closedDeliberately ? undefined : error;
    for (const handler of this.closeHandlers) handler(reported);
  }

  private async endSession(session: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.spec.url, {
        method: "DELETE",
        headers: {
          "mcp-protocol-version": mcpProtocolVersion,
          "mcp-session-id": session,
          ...this.spec.headers,
        },
        signal: controller.signal,
      });
      await response.body?.cancel().catch(() => undefined);
    } catch {
      return;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
      if (buffer.length > maxBodyChars) {
        throw new McpProtocolError("server streamed an event over the size bound");
      }
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const payload = eventData(event);
        if (payload !== "") yield payload;
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function eventData(event: string): string {
  return event
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
}

function parseJson(text: string, method: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new McpProtocolError(`server sent unparseable JSON for ${method}`);
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
