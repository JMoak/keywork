import { join } from "node:path";
import {
  Agent,
  buildSystemPrompt,
  coreTools,
  DiagnosticsLog,
  debugLogFile,
  loadProjectInstructions,
  type MemoryRecall,
  type Message,
  messageText,
  type PermissionResolver,
  type Provider,
  SessionStore,
  ShellSession,
  tapJournal,
} from "@keywork/engine";
import type { McpServerConfig, PromptsConfig } from "@keywork/shared";
import { startMcpRegistry } from "./compose.ts";
import {
  bootstrapInjection,
  memoryRecall,
  openWorkspaceMemory,
  withMemoryPrompt,
} from "./memory.ts";
import { defaultSessionDir } from "./paths.ts";
import { providerSetupHint } from "./provider.ts";
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
  print?: (line: string) => void;
  printError?: (line: string) => void;
  exit?: (code: number) => never;
}

export type HeadlessOutcome = { exitCode: 0; message: Message } | { exitCode: 1; failure: string };

export async function runHeadless(options: RunOptions): Promise<HeadlessOutcome> {
  const provider = options.provider ?? refuseWithoutProvider(options);
  const print = options.print ?? console.log;
  const printError = options.printError ?? console.error;
  const emit = (type: string, payload: unknown) => {
    if (options.json) print(JSON.stringify({ type, ...(payload as object) }));
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
    ...(options.permissions !== undefined && { permissions: options.permissions }),
    systemPrompt: withMemoryPrompt(
      buildSystemPrompt({
        ...(instructions !== undefined && { projectInstructions: instructions }),
        ...(options.prompts !== undefined && { prompts: options.prompts }),
        ...(options.modelId !== undefined && { modelId: options.modelId }),
      }),
      bootstrap,
    ),
  });
  self = agent;

  const store = await openSessionStore(options);
  const journal = store === undefined ? undefined : tapJournal(agent.bus, store);
  const diagnostics = options.debug === true ? await openDiagnostics(options) : undefined;
  diagnostics?.tap(agent.bus);
  diagnostics?.log("info", "run.started", { cwd: options.cwd, provider: provider.name });

  agent.bus.on("turn.started", (payload) => emit("turn.started", payload));
  agent.bus.on("turn.delta", (payload) => emit("turn.delta", payload));
  agent.bus.on("tool.started", (payload) => emit("tool.started", payload));
  agent.bus.on("tool.output", (payload) => emit("tool.output", payload));
  agent.bus.on("tool.finished", (payload) => emit("tool.finished", payload));
  agent.bus.on("gate.permission", (payload) => emit("gate.permission", payload));
  agent.bus.on("context.injected", (payload) => emit("context.injected", payload));
  agent.bus.on("turn.completed", (payload) => emit("turn.completed", payload));
  agent.bus.on("turn.interrupted", (payload) => emit("turn.interrupted", payload));
  agent.bus.on("engine.error", ({ error }) => emit("engine.error", { message: error.message }));

  if (instructions !== undefined) {
    agent.bus.emit("context.injected", {
      injection: { source: "project-instructions", id: "AGENTS.md" },
    });
  }
  if (bootstrap !== "") {
    agent.bus.emit("context.injected", {
      injection: { source: "memory-bootstrap", scope: "workspace" },
    });
  }

  try {
    const final = await agent.send(options.prompt);
    if (!options.json) print(messageText(final));
    return { exitCode: 0, message: final };
  } catch (cause) {
    const failure = cause instanceof Error ? cause.message : String(cause);
    if (!options.json) printError(failure);
    return { exitCode: 1, failure };
  } finally {
    await shell.close();
    journal?.stop();
    await journal?.flush();
    if (store !== undefined) for (const message of agent.history()) await store.append(message);
    await diagnostics?.flush();
    await mcp?.stop();
  }
}

function journalingRecall(
  recall: MemoryRecall | undefined,
  agent: () => Agent | undefined,
): MemoryRecall | undefined {
  if (recall === undefined) return undefined;
  return {
    ...recall,
    onRecall: (noteName) => {
      recall.onRecall?.(noteName);
      agent()?.bus.emit("context.injected", {
        injection: { source: "memory-recall", id: noteName, scope: "workspace" },
      });
    },
  };
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
  printError(providerSetupHint);
  return (options.exit ?? process.exit)(1);
}
