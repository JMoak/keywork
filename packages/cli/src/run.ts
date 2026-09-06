import { join } from "node:path";
import {
  type Agent,
  type BotDefinition,
  DiagnosticsLog,
  debugLogFile,
  type EngineEvents,
  type EventBus,
  type JournalTap,
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
} from "@keywork/engine";
import type { McpServerConfig, ModelCapabilitiesConfig, PromptsConfig } from "@keywork/shared";
import type { WorkspaceExtensions } from "./commands.ts";
import { composeAgents, composeWorkspace } from "./compose.ts";
import { type ExitClass, exitCodes } from "./dispatch.ts";
import { nextActionFor, shellCommands } from "./inference/port.ts";
import { connectHint } from "./inference/runtime.ts";
import { defaultSessionDir } from "./paths.ts";
import { newSessionFileName } from "./sessions/store.ts";

export interface RunOptions {
  prompt: string;
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
  models?: ModelCapabilitiesConfig;
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

export function exitCodeOf(outcome: HeadlessOutcome): (typeof exitCodes)[ExitClass] {
  return exitCodes[outcome.outcome];
}

export function conclude(outcome: HeadlessOutcome, io: HeadlessIo): number {
  if (io.json) io.print(JSON.stringify({ type: "run.finished", ...finishedPayload(outcome) }));
  else narrate(outcome, io);
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
  conclude(settled, io);
  return settled;
}

const headlessGuard: ToolGuard = { confirm: async () => false, gate: "headless" };

interface HeadlessRun {
  agent: Agent;
  shell: ShellSession;
  store: SessionStore | undefined;
  journal: JournalTap | undefined;
  diagnostics: DiagnosticsLog | undefined;
  mcp: McpRegistry | undefined;
}

async function openRun(
  options: RunOptions,
  provider: Provider,
  io: HeadlessIo,
): Promise<HeadlessRun | { refused: string }> {
  const composition = await composeWorkspace({
    cwd: options.cwd,
    projectTrusted: options.projectTrusted === true,
    workspaceSlug: options.workspaceSlug,
    prompts: options.prompts,
    mcpServers: options.mcpServers,
    repoMap: options.repoMap,
    models: options.models,
    checkpoints: "off",
    ...(options.userRoot !== undefined && { userRoot: options.userRoot }),
  });
  reportExtensionFailures(composition.extensions, io);
  const bot = botFor(options.bot, composition.extensions);
  if (typeof bot === "string") return { refused: bot };
  const store = await openSessionStore(options);
  if (bot !== undefined) await store?.appendBotBinding(bot.name);
  const shell = new ShellSession(options.cwd);
  const agent = composeAgents(composition, { permissions: options.permissions }).build({
    provider,
    guard: headlessGuard,
    shell,
    bot,
    sessionId: store?.header.id,
  });
  const journal = store === undefined ? undefined : tapJournal(agent.bus, store);
  const diagnostics = options.debug === true ? await openDiagnostics(options) : undefined;
  diagnostics?.tap(agent.bus);
  diagnostics?.log("info", "run.started", { cwd: options.cwd, provider: provider.name });
  return { agent, shell, store, journal, diagnostics, mcp: composition.mcp };
}

interface TurnTrace {
  emit(type: string, payload: unknown): void;
  readonly refused: readonly PermissionDecision[];
  interrupted(): boolean;
}

const forwardedEvents = [
  "turn.started",
  "turn.delta",
  "tool.started",
  "tool.output",
  "tool.finished",
  "context.injected",
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
  return { emit, refused, interrupted: () => interrupted };
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

function narrate(outcome: HeadlessOutcome, io: HeadlessIo): void {
  switch (outcome.outcome) {
    case "completed":
      io.print(messageText(outcome.message));
      return;
    case "denied":
      io.print(messageText(outcome.message));
      io.printError(refusalNotice(outcome.refused));
      return;
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
  const tools = [...new Set(refused.map((decision) => decision.tool))].join(", ");
  const calls = refused.length === 1 ? "1 tool call" : `${refused.length} tool calls`;
  return `keywork run: ${calls} needed an approval no one could give (${tools}) · rerun with --preset open to allow them`;
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
