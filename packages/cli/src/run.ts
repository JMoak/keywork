import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Agent,
  type BotDefinition,
  type ChildFinished,
  type ChildStarted,
  DiagnosticsLog,
  debugLogFile,
  type EngineEvents,
  type EventBus,
  type ExtensionHost,
  extensionLoadNotices,
  type JournalTap,
  type LanguagePort,
  type McpRegistry,
  type Message,
  messageText,
  type PermissionDecision,
  type PermissionResolver,
  type Provider,
  type ResolutionFailure,
  SessionStore,
  ShellSession,
  type ToolGuard,
  tapJournal,
  unconfinedToolName,
} from "@keywork/engine";
import type {
  KeyworkConfig,
  LspConfig,
  McpServerConfig,
  ModelCapabilitiesConfig,
  PermissionRule,
  PromptsConfig,
} from "@keywork/shared";
import { botMemory } from "./bot-memory.ts";
import type { WorkspaceExtensions } from "./commands.ts";
import { closeExtensionHost, composeAgents, composeWorkspace } from "./compose.ts";
import { type ExitClass, exitCodes } from "./dispatch.ts";
import { headlessNoticeLine } from "./extensions-command.ts";
import { nextActionFor, shellCommands } from "./inference/port.ts";
import { connectHint } from "./inference/runtime.ts";
import type { MemoryDeciderSetup } from "./memory-decider.ts";
import { defaultSessionDir } from "./paths.ts";
import { newSessionFileName } from "./sessions/store.ts";

export interface RunOptions {
  prompt: string;
  memoryDecider?: MemoryDeciderSetup;
  cwd: string;
  json: boolean;
  bot?: string;
  workspaceSlug?: string;
  projectTrusted?: boolean;
  debug?: boolean;
  sessionDir?: string;
  userRoot?: string;
  provider?: Provider;
  prompts?: PromptsConfig;
  permissions?: PermissionResolver;
  mcpServers?: Record<string, McpServerConfig>;
  repoMap?: "auto" | "off";
  lsp?: LspConfig;
  sandbox?: KeyworkConfig["sandbox"];
  models?: ModelCapabilitiesConfig;
  thinking?: KeyworkConfig["thinking"];
  signal?: AbortSignal;
  print?: (line: string) => void;
  printError?: (line: string) => void;
  exit?: (code: number) => never;
}

export type HeadlessOutcome =
  | { outcome: "completed"; message: Message }
  | { outcome: "denied"; message: Message; refused: readonly PermissionDecision[] }
  | { outcome: "interrupted"; message: Message; saved: boolean }
  | { outcome: "failed"; error: string }
  | { outcome: "unresolved"; failure: ResolutionFailure }
  | { outcome: "usage"; error: string };

export interface HeadlessIo {
  json: boolean;
  print: (line: string) => void;
  printError: (line: string) => void;
}

export interface ChildReport {
  callId: string;
  sessionId?: string;
  title: string;
  bot?: string;
  outcome: ChildFinished["outcome"];
  refused?: ChildFinished["refused"];
}

export function exitCodeOf(outcome: HeadlessOutcome): (typeof exitCodes)[ExitClass] {
  return exitCodes[outcome.outcome];
}

export function conclude(
  outcome: HeadlessOutcome,
  io: HeadlessIo,
  children: readonly ChildReport[] = [],
): number {
  if (io.json) {
    io.print(
      JSON.stringify({
        type: "run.finished",
        ...finishedPayload(outcome),
        ...(children.length > 0 && { children }),
      }),
    );
  } else {
    narrateChildren(children, io);
    narrate(outcome, io);
  }
  return exitCodeOf(outcome);
}

export async function runHeadless(options: RunOptions): Promise<HeadlessOutcome> {
  const provider = options.provider ?? refuseWithoutProvider(options);
  const io = headlessIo(options);
  const opened = await openRun(options, provider, io);
  if ("refused" in opened) {
    const settled: HeadlessOutcome = { outcome: "usage", error: opened.refused };
    conclude(settled, io);
    return settled;
  }
  const run = opened;
  const trace = traceTurn(run.agent.bus, io);
  trace.emit("run.started", {
    cwd: options.cwd,
    provider: provider.name,
    model: provider.modelId ?? null,
    session: run.store?.header.id ?? null,
  });

  const outcome = await sendPrompt(run, options, trace);
  const teardownFailures = await tearDown(run);
  const settled = teardownFailures.length === 0 ? outcome : failedTeardown(teardownFailures);
  conclude(settled, io, trace.children);
  return settled;
}

const headlessGuard: ToolGuard = {
  confirm: async () => false,
  gate: "headless",
  declineEndsRun: true,
};

interface HeadlessRun {
  agent: Agent;
  shell: ShellSession;
  store: SessionStore | undefined;
  journal: JournalTap | undefined;
  diagnostics: DiagnosticsLog | undefined;
  mcp: McpRegistry | undefined;
  languagePort: LanguagePort | undefined;
  host: ExtensionHost;
}

const runPrefix = "keywork run";

async function openRun(
  options: RunOptions,
  provider: Provider,
  io: HeadlessIo,
): Promise<HeadlessRun | { refused: string }> {
  const diagnosticsRef: { current: DiagnosticsLog | undefined } = { current: undefined };
  const composition = await composeWorkspace({
    cwd: options.cwd,
    projectTrusted: options.projectTrusted === true,
    workspaceSlug: options.workspaceSlug,
    prompts: options.prompts,
    mcpServers: options.mcpServers,
    repoMap: options.repoMap,
    models: options.models,
    checkpoints: "off",
    lsp: options.lsp,
    sandbox: options.sandbox,
    notice: (text) => io.printError(`keywork run: ${text}`),
    diagnosticsLog: () => diagnosticsRef.current,
    memoryDecider: options.memoryDecider,
    ...(options.userRoot !== undefined && { userRoot: options.userRoot }),
  });
  reportExtensionFailures(composition.extensions, io);
  for (const line of extensionLoadNotices(composition.hostReport)) {
    io.printError(`${runPrefix}: ${line}`);
  }
  composition.host.onNotice((notice) => {
    const line = headlessNoticeLine(runPrefix, notice);
    if (line !== undefined) io.printError(line);
  });
  const bot = botFor(options.bot, composition.extensions);
  if (typeof bot === "string") return { refused: bot };
  const store = await openSessionStore(options);
  if (bot !== undefined) await store?.appendBotBinding(bot.name);
  await composition.host.startSession({ reason: "start", ...(store !== undefined && { store }) });
  const children = new Map<string, SessionStore>();
  const storeOf = (sessionId: string): SessionStore | undefined =>
    sessionId === store?.header.id ? store : children.get(sessionId);
  const bots = botMemory({
    cwd: options.cwd,
    projectTrusted: options.projectTrusted === true,
    workspaceSlug: options.workspaceSlug,
    userRoot: options.userRoot ?? homedir(),
    memory: composition.memory,
    roster: composition.extensions.bots,
    bindingOf: (sessionId) => storeOf(sessionId)?.botBinding(),
  });
  await bots.prepare();
  const shell = new ShellSession(options.cwd);
  const agent = composeAgents(composition, {
    permissions: options.permissions,
    bots,
    thinking: options.thinking === "on",
    delegation: {
      storeOf,
      attach: (child) => children.set(child.header.id, child),
      release: (childId) => children.delete(childId),
    },
  }).build({
    provider,
    guard: headlessGuard,
    shell,
    bot,
    sessionId: store?.header.id,
    spills: () => store?.spills(),
  });
  const journal = store === undefined ? undefined : tapJournal(agent.bus, store);
  const diagnostics = options.debug === true ? await openDiagnostics(options) : undefined;
  diagnosticsRef.current = diagnostics;
  diagnostics?.tap(agent.bus);
  diagnostics?.log("info", "run.started", { cwd: options.cwd, provider: provider.name });
  return {
    agent,
    shell,
    store,
    journal,
    diagnostics,
    mcp: composition.mcp,
    languagePort: composition.languagePort,
    host: composition.host,
  };
}

interface TurnTrace {
  emit(type: string, payload: unknown): void;
  readonly refused: readonly PermissionDecision[];
  readonly children: readonly ChildReport[];
  interrupted(): boolean;
}

const forwardedEvents = [
  "turn.started",
  "turn.delta",
  "tool.started",
  "tool.output",
  "tool.finished",
  "context.injected",
  "diagnostics.published",
  "turn.completed",
] as const;

function traceTurn(bus: EventBus<EngineEvents>, io: HeadlessIo): TurnTrace {
  const emit = (type: string, payload: unknown): void => {
    if (io.json) io.print(JSON.stringify({ type, ...(payload as object) }));
  };
  const refused: PermissionDecision[] = [];
  let interrupted = false;
  for (const type of forwardedEvents) bus.on(type, (payload) => emit(type, payload));
  bus.on("gate.permission", (payload) => {
    if (payload.decision.gate === "headless" && payload.decision.verdict === "denied") {
      refused.push(payload.decision);
    }
    emit("gate.permission", payload);
  });
  bus.on("turn.interrupted", (payload) => {
    interrupted = true;
    emit("turn.interrupted", payload);
  });
  bus.on("engine.error", ({ error }) => emit("engine.error", { message: error.message }));
  const children = traceChildren(bus, emit, (call) =>
    refused.push({ ...call, verdict: "denied", gate: "headless" }),
  );
  return { emit, refused, children, interrupted: () => interrupted };
}

function traceChildren(
  bus: EventBus<EngineEvents>,
  emit: (type: string, payload: unknown) => void,
  refuse: (call: { tool: string; callId: string }) => void,
): readonly ChildReport[] {
  const reports: ChildReport[] = [];
  const started = new Map<string, ChildStarted>();
  bus.on("child.started", (payload) => {
    started.set(payload.callId, payload);
    emit("child.started", payload);
  });
  bus.on("child.finished", (payload) => {
    reports.push(childReportOf(started.get(payload.callId), payload));
    for (const call of payload.refused ?? []) refuse(call);
    emit("child.finished", payload);
  });
  return reports;
}

function childReportOf(started: ChildStarted | undefined, finished: ChildFinished): ChildReport {
  return {
    callId: finished.callId,
    ...(finished.sessionId !== undefined && { sessionId: finished.sessionId }),
    title: started?.title ?? "",
    ...(started?.bot !== undefined && { bot: started.bot }),
    outcome: finished.outcome,
    ...(finished.refused !== undefined && { refused: finished.refused }),
  };
}

async function sendPrompt(
  run: HeadlessRun,
  options: RunOptions,
  trace: TurnTrace,
): Promise<HeadlessOutcome> {
  try {
    const message = await run.agent.send(options.prompt, {
      ...(options.signal !== undefined && { signal: options.signal }),
    });
    if (trace.interrupted()) {
      return { outcome: "interrupted", message, saved: run.store !== undefined };
    }
    if (trace.refused.length > 0) return { outcome: "denied", message, refused: trace.refused };
    return { outcome: "completed", message };
  } catch (cause) {
    return { outcome: "failed", error: messageOf(cause) };
  }
}

type TeardownStep = [name: string, step: () => Promise<unknown>];

function tearDown(run: HeadlessRun): Promise<string[]> {
  return settleEach([
    ["closing the shell", () => run.shell.close()],
    [
      "flushing the session journal",
      async () => {
        run.journal?.stop();
        await run.journal?.flush();
      },
    ],
    [
      "saving the session",
      async () => {
        if (run.store === undefined) return;
        for (const message of run.agent.history()) await run.store.append(message);
      },
    ],
    ["stopping extensions", () => closeExtensionHost(run.host)],
    ["stopping language servers", async () => run.languagePort?.dispose()],
    ["flushing the debug log", async () => run.diagnostics?.flush()],
    ["stopping MCP servers", async () => run.mcp?.stop()],
  ]);
}

async function settleEach(steps: readonly TeardownStep[]): Promise<string[]> {
  const failures: string[] = [];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (cause) {
      failures.push(`${name} failed: ${messageOf(cause)}`);
    }
  }
  return failures;
}

function failedTeardown(failures: readonly string[]): HeadlessOutcome {
  return { outcome: "failed", error: `keywork run: the turn ended but ${failures.join(" · ")}` };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function finishedPayload(outcome: HeadlessOutcome): Record<string, unknown> {
  const base = { outcome: outcome.outcome, exitCode: exitCodeOf(outcome) };
  switch (outcome.outcome) {
    case "completed":
    case "interrupted":
      return { ...base, message: messageText(outcome.message) };
    case "denied":
      return {
        ...base,
        message: messageText(outcome.message),
        refused: outcome.refused.map(({ tool, callId }) => ({ tool, callId })),
      };
    case "failed":
    case "usage":
      return { ...base, error: outcome.error };
    case "unresolved":
      return {
        ...base,
        failure: { ...outcome.failure, nextAction: nextActionFor(outcome.failure, shellCommands) },
      };
  }
}

function narrateChildren(children: readonly ChildReport[], io: HeadlessIo): void {
  for (const child of children) {
    const who = child.bot === undefined ? "" : ` · ${child.bot}`;
    const where = child.sessionId === undefined ? "unsaved" : child.sessionId.slice(0, 8);
    io.printError(`keywork run: child ${where}${who} · ${child.title} · ${child.outcome}`);
  }
}

function narrate(outcome: HeadlessOutcome, io: HeadlessIo): void {
  switch (outcome.outcome) {
    case "completed":
      io.print(messageText(outcome.message));
      return;
    case "denied": {
      const said = messageText(outcome.message);
      if (said !== "") io.print(said);
      io.printError(refusalNotice(outcome.refused));
      return;
    }
    case "interrupted": {
      const partial = messageText(outcome.message);
      if (partial !== "") io.print(partial);
      io.printError(
        outcome.saved
          ? "keywork run: interrupted · the session was saved up to this point"
          : "keywork run: interrupted · nothing was saved, pass --session-dir to keep partial runs",
      );
      return;
    }
    case "failed":
      io.printError(outcome.error);
      return;
    case "unresolved":
      io.printError(
        `${outcome.failure.message} · ${nextActionFor(outcome.failure, shellCommands)}\n\n${connectHint}`,
      );
      return;
    case "usage":
      io.printError(outcome.error);
      return;
  }
}

function refusalNotice(refused: readonly PermissionDecision[]): string {
  const gated = refused.filter((decision) => decision.tool !== unconfinedToolName);
  const sandbox = gated.length < refused.length ? [sandboxRefusal] : [];
  if (gated.length === 0) return `keywork run: ${sandboxRefusal}`;
  const tools = [...new Set(gated.map((decision) => decision.tool))];
  const calls = gated.length === 1 ? "1 tool call" : `${gated.length} tool calls`;
  const gate = `${calls} needed an approval no one could give (${tools.join(", ")}), so the run stopped there · ${allowAdvice(tools)}`;
  return `keywork run: ${[gate, ...sandbox].join(" · ")}`;
}

const sandboxRefusal = `the sandbox can't run on this host and no one could allow running unconfined, so every command was refused · set "sandbox": "off" in ~/.keywork/keywork.json or run where the sandbox can`;

function allowAdvice(tools: readonly string[]): string {
  if (!tools.some(isMcpTool)) return "rerun with --preset open to allow them";
  const rules = tools.map((tool) => JSON.stringify(allowRuleFor(tool))).join(", ");
  return `to allow them, add ${rules} to the permissions list in ~/.keywork/keywork.json`;
}

function allowRuleFor(tool: string): PermissionRule {
  return isMcpTool(tool)
    ? { action: "mcp", resource: tool, effect: "allow" }
    : { action: tool, resource: "*", effect: "allow" };
}

function isMcpTool(tool: string): boolean {
  return tool.includes("__");
}

function botFor(
  requested: string | undefined,
  extensions: WorkspaceExtensions,
): BotDefinition | string | undefined {
  if (requested === undefined) return undefined;
  const found = extensions.bots.find((bot) => bot.name === requested);
  if (found !== undefined) return found;
  const known = extensions.bots.map((bot) => bot.name);
  const available =
    known.length === 0 ? "no bots are defined here" : `bots here: ${known.join(", ")}`;
  return `keywork run: no bot named "${requested}" (${available})`;
}

function reportExtensionFailures(extensions: WorkspaceExtensions, io: HeadlessIo): void {
  for (const failure of extensions.failures) {
    io.printError(`keywork run: skipped extension ${failure.file} · ${failure.reason}`);
  }
}

function headlessIo(options: RunOptions): HeadlessIo {
  return {
    json: options.json,
    print: options.print ?? console.log,
    printError: options.printError ?? console.error,
  };
}

function openSessionStore(options: RunOptions): Promise<SessionStore> | undefined {
  if (options.sessionDir === undefined) return undefined;
  return SessionStore.create(join(options.sessionDir, newSessionFileName()), options.cwd);
}

function openDiagnostics(options: RunOptions): Promise<DiagnosticsLog> {
  const sessionDir = options.sessionDir ?? defaultSessionDir(options.cwd, options.workspaceSlug);
  const printError = options.printError ?? console.error;
  return DiagnosticsLog.open(debugLogFile(sessionDir), {
    onWriteFailure: (error) => printError(`keywork run: debug log write failed · ${error.message}`),
  });
}

function refuseWithoutProvider(options: RunOptions): never {
  const printError = options.printError ?? console.error;
  printError(connectHint);
  return (options.exit ?? process.exit)(exitCodes.unresolved);
}
