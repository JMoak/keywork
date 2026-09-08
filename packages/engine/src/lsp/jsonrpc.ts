import type { ChildProcess } from "node:child_process";
import { killTree, within } from "../proc.ts";

const headerTerminator = "\r\n\r\n";
const maxFrameBytes = 16 * 1024 * 1024;
const stderrTailChars = 400;

export type JsonRpcParams = Record<string, unknown>;

export interface JsonRpcExit {
  code: number | null;
  stderrTail: string;
}

export class JsonRpcClosedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "JsonRpcClosedError";
  }
}

export class JsonRpcTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`${method} did not answer within ${timeoutMs}ms`);
    this.name = "JsonRpcTimeoutError";
  }
}

export class JsonRpcResponseError extends Error {
  constructor(method: string, detail: string) {
    super(`${method} failed: ${detail}`);
    this.name = "JsonRpcResponseError";
  }
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class JsonRpcStdio {
  readonly exited: Promise<JsonRpcExit>;
  readonly gone: Promise<void>;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Map<string, (params: unknown) => void>();
  private buffer: Buffer = Buffer.alloc(0);
  private stderrTail = "";
  private nextId = 1;
  private closeReason: string | undefined;

  constructor(private readonly child: ChildProcess) {
    this.exited = new Promise((resolve) => {
      child.once("exit", (code) => resolve({ code, stderrTail: this.stderrTail.trim() }));
      child.once("error", (error) =>
        resolve({ code: null, stderrTail: `${this.stderrTail}${error.message}`.trim() }),
      );
    });
    this.gone = this.exited.then(() => undefined);
    child.stdin?.on("error", () => {});
    child.stdout?.on("data", (chunk: Buffer) => this.receive(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-stderrTailChars);
    });
    child.on("error", (error) => this.settleClosed(`failed to start: ${error.message}`));
    child.on("exit", (code) => this.settleClosed(`exited with code ${code ?? "unknown"}`));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get closed(): boolean {
    return this.closeReason !== undefined;
  }

  request(method: string, params: JsonRpcParams, timeoutMs: number): Promise<unknown> {
    if (this.closeReason !== undefined) {
      return Promise.reject(new JsonRpcClosedError(this.closeReason));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new JsonRpcTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: JsonRpcParams): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  async close(graceMs: number): Promise<void> {
    this.child.stdin?.end();
    if (await within(this.gone, graceMs)) return;
    await killTree(this.child, this.gone);
  }

  kill(): Promise<void> {
    return killTree(this.child, this.gone);
  }

  private send(message: Record<string, unknown>): void {
    if (this.closeReason !== undefined) return;
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.child.stdin?.write(`Content-Length: ${body.byteLength}${headerTerminator}`);
    this.child.stdin?.write(body);
  }

  private receive(chunk: Buffer): void {
    if (this.closeReason !== undefined) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let frame = nextFrame(this.buffer);
    while (frame !== undefined) {
      this.buffer = this.buffer.subarray(frame.end);
      this.dispatchFrame(frame.body);
      frame = nextFrame(this.buffer);
    }
    if (this.buffer.byteLength > maxFrameBytes) {
      this.buffer = Buffer.alloc(0);
      this.settleClosed(`sent over ${maxFrameBytes} bytes without a complete frame`);
      void this.kill().catch(() => undefined);
    }
  }

  private dispatchFrame(body: string): void {
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    this.dispatch(message as Record<string, unknown>);
  }

  private dispatch(message: Record<string, unknown>): void {
    if (typeof message.method === "string") {
      this.dispatchIncoming(message.method, message.params, message.id);
      return;
    }
    if (typeof message.id !== "number") return;
    const request = this.pending.get(message.id);
    if (request === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error !== undefined) {
      request.reject(new JsonRpcResponseError(request.method, describeError(message.error)));
      return;
    }
    request.resolve(message.result);
  }

  private dispatchIncoming(method: string, params: unknown, id: unknown): void {
    if (id !== undefined && id !== null) {
      this.send({ jsonrpc: "2.0", id, result: null });
      return;
    }
    this.notificationHandlers.get(method)?.(params);
  }

  private settleClosed(reason: string): void {
    if (this.closeReason !== undefined) return;
    this.closeReason = reason;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new JsonRpcClosedError(reason));
    }
    this.pending.clear();
  }
}

interface Frame {
  body: string;
  end: number;
}

function nextFrame(buffer: Buffer): Frame | undefined {
  const headerEnd = buffer.indexOf(headerTerminator);
  if (headerEnd === -1) return undefined;
  const length = contentLength(buffer.toString("ascii", 0, headerEnd));
  const bodyStart = headerEnd + headerTerminator.length;
  if (length === undefined) return { body: "", end: bodyStart };
  const end = bodyStart + length;
  if (buffer.byteLength < end) return undefined;
  return { body: buffer.toString("utf8", bodyStart, end), end };
}

function contentLength(headers: string): number | undefined {
  const match = /content-length:\s*(\d+)/i.exec(headers);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "server returned an error";
}
