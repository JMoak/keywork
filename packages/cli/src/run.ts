import { join } from "node:path";
import {
  Agent,
  buildSystemPrompt,
  coreTools,
  DiagnosticsLog,
  debugLogFile,
  loadProjectInstructions,
  type Message,
  messageText,
  type PermissionDecision,
  type PermissionResolver,
  type Provider,
  type ResolutionFailure,
  SessionStore,
  ShellSession,
  tapJournal,
} from "@keywork/engine";
import type { McpServerConfig, PromptsConfig } from "@keywork/shared";
import { journalingRecall, standingInjectionsFor, startMcpRegistry } from "./compose.ts";
import { type ExitClass, exitCodes } from "./dispatch.ts";
import { connectHint } from "./inference/runtime.ts";
import {
  bootstrapInjection,
  memoryRecall,
  openWorkspaceMemory,
  withMemoryPrompt,
} from "./memory.ts";
import { defaultSessionDir } from "./paths.ts";
import { newSessionFileName } from "./sessions.ts";

export interface RunOptions {
  prompt: string;
  cwd: string;
  json: boolean;
  projectTrusted?: boolean;
  debug?: boolean;
  sessionDir?: string;
  provider?: Provider;
  prompts?: PromptsConfig;
  modelId?: string;
  permissions?: PermissionResolver;
  mcpServers?: Record<string, McpServerConfig>;
  signal?: AbortSignal;
  print?: (line: string) => void;
  printError?: (line: string) => void;
  exit?: (code: number) => never;
}

export type HeadlessOutcome =
  | { outcome: "completed"; message: Message }
  | { outcome: "denied"; message: Message; refused: readonly PermissionDecision[] }
  | { outcome: "interrupted"; message: Message }
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
  const io: HeadlessIo = {
    json: options.json,
    print: options.print ?? console.log,
    printError: options.printError ?? console.error,
  };
  const emit = (type: string, payload: unknown) => {
    if (io.json) io.print(JSON.stringify({ type, ...(payload as object) }));
  };

  const instructions =
    options.projectTrusted === true ? await loadProjectInstructions(options.cwd) : undefined;
  const memory = openWorkspaceMemory(options.cwd, options.projectTrusted === true);
  const bootstrap = await bootstrapInjection(memory);
  const mcp = startMcpRegistry(options.mcpServers);
  const shell = new ShellSession(options.cwd);
  let self: Agent | undefined;
  const baseTools = coreTools(
    options.cwd,
    journalingRecall(memoryRecall(memory), () => self),
    (chunk) => self?.bus.emit("tool.output", { chunk }),
    shell,
  );
  const agent = new Agent({
    provider,
    tools: mcp === undefined ? baseTools : mcp.surface(baseTools),
    guard: { confirm: async () => false, gate: "headless" },
    ...(options.permissions !== undefined && { permissions: options.permissions }),
    systemPrompt: withMemoryPrompt(
      buildSystemPrompt({
        ...(instructions !== undefined && { projectInstructions: instructions }),
        ...(options.prompts !== undefined && { prompts: options.prompts }),
        ...(options.modelId !== undefined && { modelId: options.modelId }),
      }),
      bootstrap,
    ),
    standingInjections: standingInjectionsFor(instructions, bootstrap),
  });
  self = agent;

  const store = await openSessionStore(options);
  const journal = store === undefined ? undefined : tapJournal(agent.bus, store);
  const diagnostics = options.debug === true ? await openDiagnostics(options) : undefined;
  diagnostics?.tap(agent.bus);
  diagnostics?.log("info", "run.started", { cwd: options.cwd, provider: provider.name });

  const refused: PermissionDecision[] = [];
  let interrupted = false;
  agent.bus.on("turn.started", (payload) => emit("turn.started", payload));
  agent.bus.on("turn.delta", (payload) => emit("turn.delta", payload));
  agent.bus.on("tool.started", (payload) => emit("tool.started", payload));
  agent.bus.on("tool.output", (payload) => emit("tool.output", payload));
  agent.bus.on("tool.finished", (payload) => emit("tool.finished", payload));
  agent.bus.on("gate.permission", (payload) => {
    if (payload.decision.gate === "headless" && payload.decision.verdict === "denied") {
      refused.push(payload.decision);
    }
    emit("gate.permission", payload);
  });
  agent.bus.on("context.injected", (payload) => emit("context.injected", payload));
  agent.bus.on("turn.completed", (payload) => emit("turn.completed", payload));
  agent.bus.on("turn.interrupted", (payload) => {
    interrupted = true;
    emit("turn.interrupted", payload);
  });
  agent.bus.on("engine.error", ({ error }) => emit("engine.error", { message: error.message }));

  emit("run.started", {
    cwd: options.cwd,
    provider: provider.name,
    model: provider.modelId ?? options.modelId ?? null,
    session: store?.header.id ?? null,
  });

  let outcome: HeadlessOutcome;
  try {
    const message = await agent.send(options.prompt, options.signal);
    outcome = interrupted
      ? { outcome: "interrupted", message }
      : refused.length > 0
        ? { outcome: "denied", message, refused }
        : { outcome: "completed", message };
  } catch (cause) {
    outcome = { outcome: "failed", error: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    await shell.close();
    journal?.stop();
    await journal?.flush();
    if (store !== undefined) for (const message of agent.history()) await store.append(message);
    await diagnostics?.flush();
    await mcp?.stop();
  }
  conclude(outcome, io);
  return outcome;
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
      return { ...base, failure: outcome.failure };
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
      io.printError("keywork run: interrupted · the session was saved up to this point");
      return;
    }
    case "failed":
      io.printError(outcome.error);
      return;
    case "unresolved":
      io.printError(`${outcome.failure.message} · ${outcome.failure.nextAction}\n\n${connectHint}`);
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

function openSessionStore(options: RunOptions): Promise<SessionStore> | undefined {
  if (options.sessionDir === undefined) return undefined;
  return SessionStore.create(join(options.sessionDir, newSessionFileName()), options.cwd);
}

function openDiagnostics(options: RunOptions): Promise<DiagnosticsLog> {
  const sessionDir = options.sessionDir ?? defaultSessionDir(options.cwd);
  return DiagnosticsLog.open(debugLogFile(sessionDir));
}

function refuseWithoutProvider(options: RunOptions): never {
  const printError = options.printError ?? console.error;
  printError(connectHint);
  return (options.exit ?? process.exit)(exitCodes.unresolved);
}
