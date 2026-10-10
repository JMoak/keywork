import type { McpConnection, McpTool, McpToolResult } from "./client.ts";
import { type McpEra, McpSession, signalsToolsChanged, subscriptionMethod } from "./era.ts";
import {
  McpAbortedError,
  McpProtocolError,
  McpRequestTimeoutError,
  McpRpcError,
  McpServerExitedError,
} from "./errors.ts";
import { hasValidHeaderAnnotations, modernRequestHeaders } from "./http-headers.ts";
import { asRecord } from "./wire.ts";

export interface HttpServerSpec {
  url: string;
  headers?: Record<string, string>;
}

export interface HttpConnectOptions {
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  rememberedEra?: McpEra;
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
    await channel.handshake(options.rememberedEra);
  } catch (cause) {
    await channel.close().catch(() => undefined);
    throw cause;
  }
  return channel;
}

const maxBodyChars = 16 * 1024 * 1024;

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

type OpenStream = (signal: AbortSignal) => Promise<Response>;

class HttpChannel implements McpConnection {
  private readonly session: McpSession;
  private readonly spec: HttpServerSpec;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly closeHandlers: Array<(error?: Error) => void> = [];
  private readonly toolsChangedHandlers: Array<() => void> = [];
  private readonly inflight = new Set<AbortController>();
  private toolSchemas = new Map<string, Record<string, unknown>>();
  private sessionId: string | undefined;
  private subscriptionId: number | undefined;
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
    this.session = new McpSession(
      {
        request: (method, params) => this.request(method, params),
        notify: (method) => this.notify(method),
      },
      () => this.announceToolsChanged(),
    );
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
    if (this.session.era === "legacy") this.follow((signal) => this.openLegacyEventStream(signal));
    else if (this.session.listensForToolChanges) this.follow((signal) => this.subscribe(signal));
  }

  async listTools(): Promise<McpTool[]> {
    const listed = await this.session.listTools();
    const usable =
      this.session.era === "modern"
        ? listed.filter((tool) => hasValidHeaderAnnotations(tool.inputSchema))
        : listed;
    this.toolSchemas = new Map(usable.map((tool) => [tool.name, tool.inputSchema]));
    return usable;
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

  async close(): Promise<void> {
    this.closedDeliberately = true;
    const session = this.sessionId;
    this.settleClosed(new McpServerExitedError("connection closed"));
    if (session !== undefined) await this.endSession(session);
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw this.exitError ?? new McpServerExitedError("connection is closed");
    const id = this.nextId++;
    const message = await this.withTimeout(method, async (signal) => {
      const response = await this.post({ jsonrpc: "2.0", id, method, params }, signal);
      return this.readRpcResponse(response, id, method);
    });
    if (message.error !== undefined) throw new McpRpcError(message.error);
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

  private async post(message: RpcMessage, signal: AbortSignal): Promise<Response> {
    const response = await this.fetchImpl(this.spec.url, {
      method: "POST",
      headers: this.headers({
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...this.eraHeaders(message),
      }),
      body: JSON.stringify(message),
      signal,
    });
    const session = response.headers.get("mcp-session-id");
    if (session !== null && this.session.era === "legacy") this.sessionId = session;
    return response;
  }

  private eraHeaders(message: RpcMessage): Record<string, string> {
    if (this.session.era === "legacy") return {};
    return modernRequestHeaders(message.method, message.params ?? {}, (tool) =>
      this.toolSchemas.get(tool),
    );
  }

  private async readRpcResponse(
    response: Response,
    id: number,
    method: string,
  ): Promise<Record<string, unknown>> {
    if (!response.ok) throw await refusal(response, method);
    if (isEventStream(response)) return this.responseFromStream(response, id, method);
    return asRecord(parseJson(await boundedText(response, method), method));
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

  private openLegacyEventStream(signal: AbortSignal): Promise<Response> {
    return this.fetchImpl(this.spec.url, {
      method: "GET",
      headers: this.headers({ accept: "text/event-stream" }),
      signal,
    });
  }

  private subscribe(signal: AbortSignal): Promise<Response> {
    const id = this.nextId++;
    this.subscriptionId = id;
    const params = this.session.subscriptionParams();
    return this.post({ jsonrpc: "2.0", id, method: subscriptionMethod, params }, signal);
  }

  private follow(open: OpenStream): void {
    const controller = new AbortController();
    this.inflight.add(controller);
    void this.followEvents(open, controller.signal).finally(() => this.inflight.delete(controller));
  }

  private async followEvents(open: OpenStream, signal: AbortSignal): Promise<void> {
    let response: Response;
    try {
      response = await open(signal);
    } catch {
      return;
    }
    if (!response.ok || response.body === null || !isEventStream(response)) {
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
    if (signalsToolsChanged(message, this.subscriptionId)) this.announceToolsChanged();
  }

  private announceToolsChanged(): void {
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
      "mcp-protocol-version": this.session.protocolVersion,
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
        headers: this.headers({ "mcp-session-id": session }),
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

async function refusal(response: Response, method: string): Promise<McpProtocolError> {
  const body = await response.text().catch(() => "");
  const error = asRecord(tryParseJson(body.slice(0, maxBodyChars))).error;
  if (typeof asRecord(error).code === "number") return new McpRpcError(error);
  return new McpProtocolError(`server answered ${response.status} to ${method}`);
}

function isEventStream(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes("text/event-stream");
}

async function boundedText(response: Response, method: string): Promise<string> {
  const text = await response.text();
  if (text.length > maxBodyChars) {
    throw new McpProtocolError(`server answered ${method} with over ${maxBodyChars} characters`);
  }
  return text;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
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
