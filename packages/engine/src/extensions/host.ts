import { type AgentHooks, proceedWith, type ToolCallRuling } from "../agent-hooks.ts";
import type { EngineEvents, EventBus } from "../bus.ts";
import type { ToolCallPart } from "../messages.ts";
import type { SessionEntry } from "../session/entries.ts";
import type { SessionStore } from "../session/store.ts";
import type { Tool } from "../tools.ts";
import { appendExtensionEntry, extensionEntries } from "./extension-entries.ts";
import type {
  CustomEntryDelivery,
  ExtensionApi,
  ExtensionCommand,
  ExtensionDefinition,
  ExtensionFlag,
  ExtensionLogger,
  ExtensionLogLevel,
  ExtensionShortcut,
  ExtensionSource,
  ExtensionTeardown,
  HookHandler,
  HookHandlers,
  HookName,
  HookPayload,
  HookResult,
  SessionEndReason,
  SessionStartReason,
} from "./hooks.ts";

export interface ExtensionHostOptions {
  bus: EventBus<EngineEvents>;
  hookTimeoutMs?: number;
  reservedToolNames?: readonly string[];
}

export type ExtensionStanding = "active" | "quarantined" | "deactivated";

export interface ExtensionFailure {
  phase: string;
  reason: string;
}

export interface ExtensionStatus {
  name: string;
  source: ExtensionSource;
  file?: string;
  standing: ExtensionStanding;
  failure?: ExtensionFailure;
}

export interface ExtensionRegistrations {
  tools: string[];
  commands: string[];
  shortcuts: string[];
  flags: string[];
}

export interface ExtensionNotice {
  extension: string;
  level: ExtensionLogLevel;
  message: string;
  detail?: unknown;
}

export interface OwnedCommand extends ExtensionCommand {
  extension: string;
}

export interface OwnedShortcut extends ExtensionShortcut {
  extension: string;
}

export interface OwnedFlag extends ExtensionFlag {
  extension: string;
}

export interface SessionStartOptions {
  reason?: SessionStartReason;
  store?: SessionStore;
}

export type SessionResolver = () => string | undefined;

export interface ObserveSeams {
  session?: SessionResolver | undefined;
}

export const defaultHookTimeoutMs = 10_000;

export class HookTimeoutError extends Error {
  constructor(hook: string, ms: number) {
    super(`${hook} handler took longer than ${ms}ms`);
    this.name = "HookTimeoutError";
  }
}

export class UnknownExtensionCommandError extends Error {
  constructor(name: string) {
    super(`no extension registers the command "${name}"`);
    this.name = "UnknownExtensionCommandError";
  }
}

export class ExtensionHost {
  private readonly bus: EventBus<EngineEvents>;
  private readonly hookTimeoutMs: number;
  private readonly reservedToolNames: ReadonlySet<string>;
  private readonly loaded: LoadedExtension[] = [];
  private readonly callsInFlight = new Map<string, ToolCallPart>();
  private readonly observed = new Map<EventBus<EngineEvents>, () => void>();
  private readonly sessions = new Map<string, SessionStore>();
  private queue: Promise<unknown> = Promise.resolve();
  private current: string | undefined;

  constructor(options: ExtensionHostOptions) {
    this.bus = options.bus;
    this.hookTimeoutMs = options.hookTimeoutMs ?? defaultHookTimeoutMs;
    this.reservedToolNames = new Set(options.reservedToolNames ?? []);
    this.observe(this.bus);
  }

  async activate(definition: ExtensionDefinition): Promise<ExtensionStatus> {
    const taken = this.loaded.find((candidate) => candidate.definition.name === definition.name);
    if (taken !== undefined) {
      return this.quarantineUnloaded(definition, `the name is already taken by ${describe(taken)}`);
    }
    const extension = freshlyLoaded(definition);
    this.loaded.push(extension);
    await this.guarded(extension, "activate", async () => {
      const teardown: unknown = await definition.activate(this.apiFor(extension));
      if (typeof teardown === "function") extension.teardown = teardown as ExtensionTeardown;
    });
    return statusOf(extension);
  }

  quarantineUnloaded(
    definition: Omit<ExtensionDefinition, "activate">,
    reason: string,
  ): ExtensionStatus {
    const extension = freshlyLoaded({ ...definition, activate: () => undefined });
    this.loaded.push(extension);
    this.quarantine(extension, "load", new Error(reason));
    return statusOf(extension);
  }

  observe(bus: EventBus<EngineEvents>, seams: ObserveSeams = {}): () => void {
    const already = this.observed.get(bus);
    if (already !== undefined) return already;
    const subscriptions = this.subscribeToTurns(bus, seams.session);
    const stop = (): void => {
      for (const unsubscribe of subscriptions) unsubscribe();
      this.observed.delete(bus);
    };
    this.observed.set(bus, stop);
    return stop;
  }

  onNotice(listener: (notice: ExtensionNotice) => void): () => void {
    return this.bus.on("extension.notice", listener);
  }

  async deactivateAll(): Promise<void> {
    await this.settle();
    for (const extension of this.active()) {
      await this.runTeardown(extension);
      extension.standing = "deactivated";
    }
  }

  async dispose(): Promise<void> {
    await this.deactivateAll();
    for (const stop of [...this.observed.values()]) stop();
  }

  extensions(): ExtensionStatus[] {
    return this.loaded.map(statusOf);
  }

  registrations(name: string): ExtensionRegistrations {
    const extension = this.loaded.find((candidate) => candidate.definition.name === name);
    return {
      tools: extension?.tools.map((tool) => tool.name) ?? [],
      commands: extension?.commands.map((command) => command.name) ?? [],
      shortcuts: extension?.shortcuts.map((shortcut) => shortcut.keys) ?? [],
      flags: extension?.flags.map((flag) => flag.name) ?? [],
    };
  }

  tools(): Tool[] {
    return this.active().flatMap((extension) => extension.tools);
  }

  commands(): OwnedCommand[] {
    return this.active().flatMap((extension) =>
      extension.commands.map((command) => ({ ...command, extension: extension.definition.name })),
    );
  }

  shortcuts(): OwnedShortcut[] {
    return this.active().flatMap((extension) =>
      extension.shortcuts.map((shortcut) => ({
        ...shortcut,
        extension: extension.definition.name,
      })),
    );
  }

  flags(): OwnedFlag[] {
    return this.active().flatMap((extension) =>
      extension.flags.map((flag) => ({ ...flag, extension: extension.definition.name })),
    );
  }

  openSessions(): string[] {
    return [...this.sessions.keys()];
  }

  async runCommand(name: string, args: string): Promise<string | undefined> {
    const owner = this.active().find((extension) =>
      extension.commands.some((command) => command.name === name),
    );
    const command = owner?.commands.find((candidate) => candidate.name === name);
    if (owner === undefined || command === undefined) throw new UnknownExtensionCommandError(name);
    return this.enqueue(async () => {
      const output = await this.guarded(owner, `command /${name}`, () => command.run(args));
      return typeof output === "string" ? output : undefined;
    });
  }

  agentHooks(seams: ObserveSeams = {}): AgentHooks {
    const session = seams.session;
    return {
      tools: () => this.tools(),
      systemPrompt: (base) =>
        this.anyoneListensTo("context")
          ? this.enqueue(() => this.composeSystemPrompt(base), session)
          : Promise.resolve(base),
      toolCall: (call) =>
        this.anyoneListensTo("tool_call")
          ? this.enqueue(() => this.ruleOnToolCall(call), session)
          : Promise.resolve(proceedWith(call)),
      messageAppended: (message) => {
        if (this.anyoneListensTo("message_appended")) {
          void this.dispatch("message_appended", { message }, session);
        }
      },
    };
  }

  async startSession(options: SessionStartOptions = {}): Promise<void> {
    const store = options.store;
    const sessionId = store?.header.id;
    if (store !== undefined && sessionId !== undefined) {
      this.sessions.set(sessionId, store);
      await this.replayEntries(store.activePath(), sessionId);
    }
    await this.dispatch(
      "session_start",
      { reason: options.reason ?? "start", ...(sessionId !== undefined && { sessionId }) },
      () => sessionId,
    );
  }

  async endSession(reason: SessionEndReason = "exit", sessionId?: string): Promise<void> {
    if (sessionId !== undefined) {
      if (this.sessions.has(sessionId)) await this.closeSession(reason, sessionId);
      return;
    }
    const open = this.openSessions();
    if (open.length === 0) await this.dispatch("session_end", { reason });
    for (const id of open) await this.closeSession(reason, id);
  }

  async settle(): Promise<void> {
    let seen: Promise<unknown>;
    do {
      seen = this.queue;
      await seen;
    } while (seen !== this.queue);
  }

  private async closeSession(reason: SessionEndReason, sessionId: string): Promise<void> {
    await this.dispatch("session_end", { reason, sessionId }, () => sessionId);
    this.sessions.delete(sessionId);
  }

  private subscribeToTurns(
    bus: EventBus<EngineEvents>,
    session: SessionResolver | undefined,
  ): Array<() => void> {
    return [
      bus.on("turn.started", ({ userText, replay }) => {
        if (replay !== true) void this.dispatch("turn_start", { userText }, session);
      }),
      bus.on("turn.completed", ({ message, replay }) => {
        if (replay !== true) {
          void this.dispatch("turn_end", { message, interrupted: false }, session);
        }
      }),
      bus.on("turn.interrupted", ({ message, replay }) => {
        if (replay !== true)
          void this.dispatch("turn_end", { message, interrupted: true }, session);
      }),
      bus.on("tool.started", ({ call, replay }) => {
        if (replay !== true) this.callsInFlight.set(call.callId, call);
      }),
      bus.on("tool.finished", ({ callId, output, isError, replay }) => {
        if (replay === true) return;
        const call = this.callsInFlight.get(callId);
        this.callsInFlight.delete(callId);
        void this.dispatch("tool_result", { callId, call, output, isError }, session);
      }),
    ];
  }

  private dispatch<K extends HookName>(
    hook: K,
    payload: HookPayload<K>,
    session?: SessionResolver,
  ): Promise<void> {
    return this.enqueue(async () => {
      for (const extension of this.active()) await this.deliver(extension, hook, payload);
    }, session);
  }

  private async deliver<K extends HookName>(
    extension: LoadedExtension,
    hook: K,
    payload: HookPayload<K>,
  ): Promise<void> {
    for (const handler of handlersOf(extension, hook)) {
      if (extension.standing !== "active") return;
      await this.invoke(extension, hook, handler, payload);
    }
  }

  private async ruleOnToolCall(requested: ToolCallPart): Promise<ToolCallRuling> {
    let call = requested;
    for (const extension of this.active()) {
      for (const handler of handlersOf(extension, "tool_call")) {
        if (extension.standing !== "active") break;
        const decision = await this.invoke(extension, "tool_call", handler, { call });
        if (decision?.action === "deny") {
          return { kind: "refuse", reason: `${extension.definition.name}: ${decision.reason}` };
        }
        if (decision?.action === "modify") call = { ...call, arguments: decision.arguments };
      }
    }
    return proceedWith(call);
  }

  private async composeSystemPrompt(base: string): Promise<string> {
    const fragments = [base];
    for (const extension of this.active()) {
      for (const handler of handlersOf(extension, "context")) {
        if (extension.standing !== "active") break;
        const fragment = await this.invoke(extension, "context", handler, { systemPrompt: base });
        if (typeof fragment === "string") fragments.push(fragment);
      }
    }
    return fragments.filter((fragment) => fragment.trim() !== "").join("\n\n");
  }

  private replayEntries(entries: readonly SessionEntry[], sessionId: string): Promise<void> {
    return this.enqueue(
      async () => {
        for (const entry of extensionEntries(entries)) {
          const owner = this.active().find(
            (candidate) => candidate.definition.name === entry.extension,
          );
          if (owner === undefined) continue;
          await this.deliverEntry(owner, { type: entry.type, data: entry.data, replay: true });
        }
      },
      () => sessionId,
    );
  }

  private async appendEntry(
    extension: LoadedExtension,
    type: string,
    data: unknown,
  ): Promise<void> {
    if (extension.standing !== "active") return;
    const target = this.entryTarget();
    if (typeof target === "string") {
      this.notify(extension, "warn", `entry "${type}" was dropped: ${target}`);
      return;
    }
    await appendExtensionEntry(target, { extension: extension.definition.name, type, data });
    await this.deliverEntry(extension, { type, data, replay: false });
  }

  private entryTarget(): SessionStore | string {
    const inFlight = this.current === undefined ? undefined : this.sessions.get(this.current);
    if (inFlight !== undefined) return inFlight;
    const open = [...this.sessions.values()];
    if (open.length === 1 && open[0] !== undefined) return open[0];
    return open.length === 0
      ? "no session is open"
      : `${open.length} sessions are open and no turn names one`;
  }

  private async deliverEntry(
    extension: LoadedExtension,
    delivery: CustomEntryDelivery,
  ): Promise<void> {
    for (const handler of handlersOf(extension, "custom_entry")) {
      if (extension.standing !== "active") return;
      await this.invoke(extension, "custom_entry", handler, delivery);
    }
  }

  private invoke<K extends HookName>(
    extension: LoadedExtension,
    hook: K,
    handler: HookHandler<K>,
    payload: HookPayload<K>,
  ): Promise<HookResult<K> | undefined> {
    return this.guarded(extension, hook, async () => {
      const result: unknown = await handler(payload);
      return result === undefined ? undefined : (result as HookResult<K>);
    });
  }

  private async guarded<T>(
    extension: LoadedExtension,
    phase: string,
    work: () => Promise<T> | T,
  ): Promise<T | undefined> {
    try {
      return await withDeadline(work, this.hookTimeoutMs, phase);
    } catch (cause) {
      this.quarantine(extension, phase, cause);
      return undefined;
    }
  }

  private quarantine(extension: LoadedExtension, phase: string, cause: unknown): void {
    if (extension.standing === "quarantined") return;
    const reason = reasonOf(cause);
    extension.standing = "quarantined";
    extension.failure = { phase, reason };
    withdrawRegistrations(extension);
    this.notify(
      extension,
      "error",
      `extension "${extension.definition.name}" quarantined during ${phase}: ${reason}`,
    );
    void this.runTeardown(extension);
  }

  private async runTeardown(extension: LoadedExtension): Promise<void> {
    const teardown = extension.teardown;
    extension.teardown = undefined;
    if (teardown === undefined) return;
    try {
      await withDeadline(teardown, this.hookTimeoutMs, "deactivate");
    } catch (cause) {
      extension.failure ??= { phase: "deactivate", reason: reasonOf(cause) };
      this.notify(
        extension,
        "warn",
        `teardown of "${extension.definition.name}" failed: ${reasonOf(cause)}`,
      );
    }
  }

  private enqueue<T>(work: () => Promise<T>, session?: SessionResolver): Promise<T> {
    const next = this.queue.then(async () => {
      this.current = session?.();
      try {
        return await work();
      } finally {
        this.current = undefined;
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private active(): LoadedExtension[] {
    return this.loaded.filter((extension) => extension.standing === "active");
  }

  private anyoneListensTo(hook: HookName): boolean {
    return this.active().some((extension) => handlersOf(extension, hook).length > 0);
  }

  private apiFor(extension: LoadedExtension): ExtensionApi {
    const whileActive = (register: () => void) => {
      if (extension.standing === "active") register();
    };
    return {
      name: extension.definition.name,
      source: extension.definition.source,
      log: this.loggerFor(extension),
      on: (hook, handler) => this.subscribe(extension, hook, handler),
      registerTool: (tool) => whileActive(() => this.adoptTool(extension, tool)),
      registerCommand: (command) => whileActive(() => extension.commands.push(command)),
      registerShortcut: (shortcut) => whileActive(() => extension.shortcuts.push(shortcut)),
      registerFlag: (flag) => whileActive(() => extension.flags.push(flag)),
      appendEntry: (type, data) => this.appendEntry(extension, type, data),
    };
  }

  private subscribe<K extends HookName>(
    extension: LoadedExtension,
    hook: K,
    handler: HookHandlers[K],
  ): () => void {
    if (extension.standing !== "active") return () => undefined;
    const handlers = handlersOf(extension, hook);
    handlers.push(handler);
    return () => {
      const index = handlers.indexOf(handler);
      if (index !== -1) handlers.splice(index, 1);
    };
  }

  private adoptTool(extension: LoadedExtension, tool: Tool): void {
    if (this.reservedToolNames.has(tool.name)) {
      throw new Error(`tool "${tool.name}" is reserved by keywork`);
    }
    const owner = this.active().find((candidate) =>
      candidate.tools.some((existing) => existing.name === tool.name),
    );
    if (owner !== undefined) {
      throw new Error(`tool "${tool.name}" is already registered by ${describe(owner)}`);
    }
    extension.tools.push(tool);
  }

  private loggerFor(extension: LoadedExtension): ExtensionLogger {
    return {
      info: (message, detail) => this.notify(extension, "info", message, detail),
      warn: (message, detail) => this.notify(extension, "warn", message, detail),
      error: (message, detail) => this.notify(extension, "error", message, detail),
    };
  }

  private notify(
    extension: LoadedExtension,
    level: ExtensionLogLevel,
    message: string,
    detail?: unknown,
  ): void {
    this.bus.emit("extension.notice", {
      extension: extension.definition.name,
      level,
      message,
      ...(detail !== undefined && { detail }),
    });
  }
}

type HandlerTable = { [K in HookName]?: HookHandler<K>[] };

interface LoadedExtension {
  readonly definition: ExtensionDefinition;
  standing: ExtensionStanding;
  failure: ExtensionFailure | undefined;
  handlers: HandlerTable;
  tools: Tool[];
  commands: ExtensionCommand[];
  shortcuts: ExtensionShortcut[];
  flags: ExtensionFlag[];
  teardown: ExtensionTeardown | undefined;
}

function freshlyLoaded(definition: ExtensionDefinition): LoadedExtension {
  return {
    definition,
    standing: "active",
    failure: undefined,
    handlers: {},
    tools: [],
    commands: [],
    shortcuts: [],
    flags: [],
    teardown: undefined,
  };
}

function handlersOf<K extends HookName>(extension: LoadedExtension, hook: K): HookHandler<K>[] {
  const table: HandlerTable = extension.handlers;
  const existing = table[hook];
  if (existing !== undefined) return existing;
  const made: HookHandler<K>[] = [];
  table[hook] = made as HandlerTable[K];
  return made;
}

function withdrawRegistrations(extension: LoadedExtension): void {
  extension.handlers = {};
  extension.tools = [];
  extension.commands = [];
  extension.shortcuts = [];
  extension.flags = [];
}

function statusOf(extension: LoadedExtension): ExtensionStatus {
  const { name, source, file } = extension.definition;
  return {
    name,
    source,
    ...(file !== undefined && { file }),
    standing: extension.standing,
    ...(extension.failure !== undefined && { failure: extension.failure }),
  };
}

function describe(extension: LoadedExtension): string {
  const { name, source, file } = extension.definition;
  return file === undefined
    ? `${source} extension "${name}"`
    : `${source} extension "${name}" (${file})`;
}

async function withDeadline<T>(work: () => Promise<T> | T, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HookTimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([Promise.resolve().then(work), expired]);
  } finally {
    clearTimeout(timer);
  }
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
