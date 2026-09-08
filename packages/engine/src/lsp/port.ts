import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DiagnosticsLog } from "../diagnostics.ts";
import { within } from "../proc.ts";
import type { ToolScope } from "../tools/confine.ts";
import { JsonRpcStdio } from "./jsonrpc.ts";
import { resolveOnPath, type SpawnLike, spawnResolved } from "./path.ts";
import {
  type LanguageServerSpec,
  type LanguageServerTable,
  languageIdFor,
  languageOf,
} from "./servers.ts";

export interface LanguagePort {
  afterSave(path: string, signal?: AbortSignal): Promise<readonly Diagnostic[]>;
  languageOf(path: string): string | undefined;
  facts(): LanguageFacts;
  dispose(): Promise<void>;
}

export interface Diagnostic {
  path: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  message: string;
  source?: string | undefined;
}

export interface LanguageFacts {
  servers: readonly LanguageServerFact[];
}

export interface LanguageServerFact {
  language: string;
  command: string;
  state: ServerState;
  pid?: number | undefined;
  detail?: string | undefined;
}

export type ServerState = "idle" | "starting" | "ready" | "missing" | "failed" | "stopped";

export interface LanguageBudgets {
  initializeMs: number;
  diagnosticsMs: number;
  idleMs: number;
}

export const defaultLanguageBudgets: LanguageBudgets = {
  initializeMs: 10_000,
  diagnosticsMs: 3_000,
  idleMs: 10 * 60_000,
};

export type IdleScheduler = (check: () => void, afterMs: number) => () => void;

export interface LanguagePortOptions {
  servers: LanguageServerTable;
  budgets?: Partial<LanguageBudgets> | undefined;
  diagnostics?: Pick<DiagnosticsLog, "log"> | undefined;
  spawn?: SpawnLike | undefined;
  now?: (() => number) | undefined;
  searchPath?: string | undefined;
  scheduleIdleCheck?: IdleScheduler | undefined;
  onMissing?: ((language: string, command: string) => void) | undefined;
}

export function languagePort(scope: ToolScope, options: LanguagePortOptions): LanguagePort {
  return new LanguageServers(scope, options);
}

export function idleLanguageFacts(servers: LanguageServerTable): LanguageFacts {
  return {
    servers: Object.entries(servers).map(([language, spec]) => ({
      language,
      command: spec.command.join(" "),
      state: "idle",
    })),
  };
}

const shutdownGraceMs = 1_000;
const exitGraceMs = 500;

const scheduleWithTimers: IdleScheduler = (check, afterMs) => {
  const timer = setTimeout(check, afterMs);
  return () => clearTimeout(timer);
};

type PublishListener = (diagnostics: readonly Diagnostic[]) => void;

interface ServerSlot {
  language: string;
  spec: LanguageServerSpec;
  state: ServerState;
  detail: string | undefined;
  client: JsonRpcStdio | undefined;
  starting: Promise<JsonRpcStdio | undefined> | undefined;
  documents: Map<string, number>;
  held: Map<string, readonly Diagnostic[]>;
  listeners: Map<string, Set<PublishListener>>;
  lastTouch: number;
  cancelIdleCheck: () => void;
}

class LanguageServers implements LanguagePort {
  private readonly slots = new Map<string, ServerSlot>();
  private readonly budgets: LanguageBudgets;
  private readonly spawn: SpawnLike;
  private readonly now: () => number;
  private readonly scheduleIdleCheck: IdleScheduler;
  private disposed = false;

  constructor(
    private readonly scope: ToolScope,
    private readonly options: LanguagePortOptions,
  ) {
    this.budgets = { ...defaultLanguageBudgets, ...options.budgets };
    this.spawn = options.spawn ?? spawnResolved;
    this.now = options.now ?? Date.now;
    this.scheduleIdleCheck = options.scheduleIdleCheck ?? scheduleWithTimers;
  }

  languageOf(path: string): string | undefined {
    return languageOf(this.options.servers, path);
  }

  async afterSave(path: string, signal?: AbortSignal): Promise<readonly Diagnostic[]> {
    const language = this.languageOf(path);
    if (language === undefined || this.disposed) return [];
    const slot = this.slotFor(language);
    const client = await this.readyClient(slot);
    if (client === undefined || this.disposed || signal?.aborted === true) return [];
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text === undefined) return [];
    const key = documentKey(path);
    this.syncDocument(slot, client, path, key, text);
    this.touch(slot);
    return this.waitForPublish(slot, key, signal);
  }

  facts(): LanguageFacts {
    return {
      servers: Object.entries(this.options.servers).map(([language, spec]) => {
        const slot = this.slots.get(language);
        return {
          language,
          command: spec.command.join(" "),
          state: slot?.state ?? "idle",
          ...(slot?.client?.pid !== undefined &&
            slot.state === "ready" && { pid: slot.client.pid }),
          ...(slot?.detail !== undefined && { detail: slot.detail }),
        };
      }),
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.slots.values()].map((slot) => this.stop(slot, "stopped")));
  }

  private slotFor(language: string): ServerSlot {
    const existing = this.slots.get(language);
    if (existing !== undefined) return existing;
    const spec = this.options.servers[language];
    if (spec === undefined) throw new Error(`no language server configured for ${language}`);
    const slot: ServerSlot = {
      language,
      spec,
      state: "idle",
      detail: undefined,
      client: undefined,
      starting: undefined,
      documents: new Map(),
      held: new Map(),
      listeners: new Map(),
      lastTouch: this.now(),
      cancelIdleCheck: () => {},
    };
    this.slots.set(language, slot);
    return slot;
  }

  private readyClient(slot: ServerSlot): Promise<JsonRpcStdio | undefined> {
    switch (slot.state) {
      case "ready":
        return Promise.resolve(slot.client);
      case "starting":
        return slot.starting ?? Promise.resolve(undefined);
      case "idle":
        slot.starting = this.start(slot).finally(() => {
          slot.starting = undefined;
        });
        return slot.starting;
      default:
        return Promise.resolve(undefined);
    }
  }

  private async start(slot: ServerSlot): Promise<JsonRpcStdio | undefined> {
    const [command = "", ...args] = slot.spec.command;
    const file = resolveOnPath(command, this.options.searchPath);
    if (file === undefined) return this.markMissing(slot, command);
    slot.state = "starting";
    const client = new JsonRpcStdio(this.spawn(file, args, { cwd: this.scope.cwd }));
    slot.client = client;
    client.onNotification("textDocument/publishDiagnostics", (params) =>
      this.receivePublish(slot, params),
    );
    void client.exited.then((exit) => this.containExit(slot, client, exit.code, exit.stderrTail));
    try {
      await client.request(
        "initialize",
        this.initializeParams(slot.spec),
        this.budgets.initializeMs,
      );
    } catch (cause) {
      return this.markFailed(slot, client, `initialize: ${messageOf(cause)}`);
    }
    if (slot.client !== client || slot.state !== "starting") return undefined;
    client.notify("initialized", {});
    slot.state = "ready";
    this.touch(slot);
    return client;
  }

  private markMissing(slot: ServerSlot, command: string): undefined {
    slot.state = "missing";
    slot.detail = `${command} not on PATH`;
    this.options.diagnostics?.log("info", "lsp.missing", { language: slot.language, command });
    this.options.onMissing?.(slot.language, command);
    return undefined;
  }

  private async markFailed(
    slot: ServerSlot,
    client: JsonRpcStdio,
    reason: string,
  ): Promise<undefined> {
    if (slot.client !== client) return undefined;
    slot.state = "failed";
    slot.detail = reason;
    this.options.diagnostics?.log("error", "lsp.failed", { language: slot.language, reason });
    this.releaseWaiters(slot);
    if (!client.closed) await client.kill().catch(() => undefined);
    return undefined;
  }

  private containExit(
    slot: ServerSlot,
    client: JsonRpcStdio,
    code: number | null,
    stderrTail: string,
  ): void {
    if (slot.client !== client) return;
    if (slot.state !== "starting" && slot.state !== "ready") return;
    const reason = `exit ${code ?? "unknown"}${stderrTail === "" ? "" : ` · ${stderrTail}`}`;
    void this.markFailed(slot, client, reason);
  }

  private initializeParams(spec: LanguageServerSpec): Record<string, unknown> {
    const folders = [
      ...new Set([this.scope.cwd, ...this.scope.roots].map((root) => resolve(root))),
    ];
    return {
      processId: process.pid,
      clientInfo: { name: "keywork" },
      rootUri: pathToFileURL(this.scope.cwd).href,
      workspaceFolders: folders.map((root) => ({
        uri: pathToFileURL(root).href,
        name: basename(root),
      })),
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: false },
          publishDiagnostics: { relatedInformation: false },
        },
        workspace: { workspaceFolders: true },
      },
      ...(spec.initialization !== undefined && { initializationOptions: spec.initialization }),
    };
  }

  private syncDocument(
    slot: ServerSlot,
    client: JsonRpcStdio,
    path: string,
    key: string,
    text: string,
  ): void {
    slot.held.delete(key);
    const uri = pathToFileURL(path).href;
    const version = slot.documents.get(key);
    if (version === undefined) {
      slot.documents.set(key, 1);
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: languageIdFor(slot.language, path), version: 1, text },
      });
      return;
    }
    slot.documents.set(key, version + 1);
    client.notify("textDocument/didChange", {
      textDocument: { uri, version: version + 1 },
      contentChanges: [{ text }],
    });
  }

  private waitForPublish(
    slot: ServerSlot,
    key: string,
    signal: AbortSignal | undefined,
  ): Promise<readonly Diagnostic[]> {
    return new Promise((resolvePromise) => {
      const listeners = slot.listeners.get(key) ?? new Set<PublishListener>();
      slot.listeners.set(key, listeners);
      const finish = (diagnostics: readonly Diagnostic[]): void => {
        clearTimeout(timer);
        listeners.delete(listener);
        signal?.removeEventListener("abort", onAbort);
        resolvePromise(diagnostics);
      };
      const listener: PublishListener = (diagnostics) => finish(diagnostics);
      const onAbort = (): void => finish(slot.held.get(key) ?? []);
      const timer = setTimeout(onAbort, this.budgets.diagnosticsMs);
      listeners.add(listener);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private receivePublish(slot: ServerSlot, params: unknown): void {
    const published = parsePublish(params);
    if (published === undefined) return;
    slot.held.set(published.key, published.diagnostics);
    for (const listener of [...(slot.listeners.get(published.key) ?? [])]) {
      listener(published.diagnostics);
    }
  }

  private releaseWaiters(slot: ServerSlot): void {
    for (const [key, listeners] of slot.listeners) {
      for (const listener of [...listeners]) listener(slot.held.get(key) ?? []);
    }
  }

  private touch(slot: ServerSlot): void {
    slot.lastTouch = this.now();
    this.armIdleCheck(slot, this.budgets.idleMs);
  }

  private armIdleCheck(slot: ServerSlot, afterMs: number): void {
    slot.cancelIdleCheck();
    slot.cancelIdleCheck = this.scheduleIdleCheck(() => this.checkIdle(slot), afterMs);
  }

  private checkIdle(slot: ServerSlot): void {
    if (slot.state !== "ready") return;
    const idleFor = this.now() - slot.lastTouch;
    if (idleFor < this.budgets.idleMs) {
      this.armIdleCheck(slot, this.budgets.idleMs - idleFor);
      return;
    }
    void this.stop(slot, "idle");
  }

  private async stop(slot: ServerSlot, endState: "idle" | "stopped"): Promise<void> {
    slot.cancelIdleCheck();
    const client = slot.client;
    const wasReady = slot.state === "ready";
    if (endState === "stopped" || wasReady || slot.state === "starting") slot.state = endState;
    slot.client = undefined;
    slot.documents.clear();
    slot.held.clear();
    this.releaseWaiters(slot);
    if (client === undefined || client.closed) return;
    if (wasReady) await this.requestShutdown(client);
    await client.close(exitGraceMs).catch(() => undefined);
  }

  private async requestShutdown(client: JsonRpcStdio): Promise<void> {
    const answered = client.request("shutdown", {}, shutdownGraceMs).then(
      () => undefined,
      () => undefined,
    );
    await within(answered, shutdownGraceMs);
    client.notify("exit", {});
    await within(client.gone, exitGraceMs);
  }
}

interface Published {
  key: string;
  diagnostics: readonly Diagnostic[];
}

function parsePublish(params: unknown): Published | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const { uri, diagnostics } = params as { uri?: unknown; diagnostics?: unknown };
  if (typeof uri !== "string" || !Array.isArray(diagnostics)) return undefined;
  const path = pathOfUri(uri);
  if (path === undefined) return undefined;
  return {
    key: documentKey(path),
    diagnostics: diagnostics
      .map((entry) => parseDiagnostic(path, entry))
      .filter((entry): entry is Diagnostic => entry !== undefined),
  };
}

function parseDiagnostic(path: string, entry: unknown): Diagnostic | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const raw = entry as {
    range?: { start?: { line?: unknown; character?: unknown } };
    severity?: unknown;
    message?: unknown;
    source?: unknown;
  };
  const severity = severityOf(raw.severity);
  if (severity === undefined) return undefined;
  const start = raw.range?.start ?? {};
  return {
    path,
    line: numberOr(start.line, 0) + 1,
    column: numberOr(start.character, 0) + 1,
    severity,
    message: String(raw.message ?? ""),
    ...(typeof raw.source === "string" && { source: raw.source }),
  };
}

function severityOf(value: unknown): Diagnostic["severity"] | undefined {
  if (value === undefined || value === 1) return "error";
  if (value === 2) return "warning";
  return undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function pathOfUri(uri: string): string | undefined {
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

function documentKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
