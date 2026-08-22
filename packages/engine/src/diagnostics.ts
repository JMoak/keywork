import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EngineEvents, EventBus } from "./bus.ts";

export type DiagnosticsLevel = "debug" | "info" | "error";

export interface DiagnosticsLine {
  ts: string;
  level: DiagnosticsLevel;
  event: string;
  payload: unknown;
}

export function debugEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.KEYWORK_DEBUG?.trim().toLowerCase();
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

export function debugLogFile(sessionDir: string, now = Date.now(), pid = process.pid): string {
  return join(sessionDir, "debug", `${now}-${pid}.jsonl`);
}

export interface DiagnosticsOptions {
  onWriteFailure?: (error: Error) => void;
}

export class DiagnosticsLog {
  private pending = Promise.resolve();
  private failureReported = false;

  private constructor(
    readonly file: string,
    private readonly onWriteFailure: (error: Error) => void,
  ) {}

  static async open(file: string, options: DiagnosticsOptions = {}): Promise<DiagnosticsLog> {
    await mkdir(dirname(file), { recursive: true });
    return new DiagnosticsLog(file, options.onWriteFailure ?? (() => undefined));
  }

  log(level: DiagnosticsLevel, event: string, payload: unknown): void {
    const line: DiagnosticsLine = {
      ts: new Date().toISOString(),
      level,
      event,
      payload: redactSecrets(payload),
    };
    this.pending = this.pending.then(() => this.append(line));
  }

  tap(bus: EventBus<EngineEvents>): () => void {
    const stops = [
      bus.on("turn.started", (payload) => this.log("info", "turn.started", payload)),
      bus.on("turn.delta", (payload) => this.log("debug", "turn.delta", payload)),
      bus.on("turn.completed", (payload) => this.log("info", "turn.completed", payload)),
      bus.on("turn.interrupted", (payload) => this.log("info", "turn.interrupted", payload)),
      bus.on("tool.started", (payload) => this.log("info", "tool.started", payload)),
      bus.on("tool.finished", (payload) => this.log("info", "tool.finished", payload)),
      bus.on("engine.error", (payload) => this.log("error", "engine.error", payload)),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }

  flush(): Promise<void> {
    return this.pending;
  }

  private async append(line: DiagnosticsLine): Promise<void> {
    try {
      await appendFile(this.file, `${JSON.stringify(line)}\n`, "utf8");
      this.failureReported = false;
    } catch (cause) {
      this.reportWriteFailureOnce(cause);
    }
  }

  private reportWriteFailureOnce(cause: unknown): void {
    if (this.failureReported) return;
    this.failureReported = true;
    this.onWriteFailure(cause instanceof Error ? cause : new Error(String(cause)));
  }
}

export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") return redactKeyShapes(value);
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value instanceof Error) return { name: value.name, message: redactKeyShapes(value.message) };
  if (value !== null && typeof value === "object") return redactObject(value);
  return value;
}

const secretFieldName = /key|token|secret|password|credential|authorization/i;
const keyShapes = [/\bsk-[\w-]{8,}/g, /\bBearer\s+[\w.~+/=-]+/gi];

function redactObject(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([name, entry]) => [name, redactField(name, entry)]),
  );
}

function redactField(name: string, entry: unknown): unknown {
  const hidesWholeValue = secretFieldName.test(name) && typeof entry !== "number";
  return hidesWholeValue ? "[redacted]" : redactSecrets(entry);
}

function redactKeyShapes(text: string): string {
  return keyShapes.reduce((scrubbed, shape) => scrubbed.replace(shape, "[redacted]"), text);
}
