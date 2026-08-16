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
  type PermissionResolver,
  type Provider,
  SessionStore,
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

export async function runHeadless(options: RunOptions): Promise<Message> {
  const provider = options.provider ?? refuseWithoutProvider(options);
  const print = options.print ?? console.log;
  const emit = (type: string, payload: unknown) => {
    if (options.json) print(JSON.stringify({ type, ...(payload as object) }));
  };

  const instructions =
    options.projectTrusted === true ? await loadProjectInstructions(options.cwd) : undefined;
  const memory = openWorkspaceMemory(options.cwd, options.projectTrusted === true);
  const mcp = startMcpRegistry(options.mcpServers);
  let self: Agent | undefined;
  const baseTools = coreTools(options.cwd, memoryRecall(memory), (chunk) =>
    self?.bus.emit("tool.output", { chunk }),
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
      await bootstrapInjection(memory),
    ),
  });
  self = agent;

  const diagnostics = options.debug === true ? await openDiagnostics(options) : undefined;
  diagnostics?.tap(agent.bus);
  diagnostics?.log("info", "run.started", { cwd: options.cwd, provider: provider.name });

  agent.bus.on("turn.started", (payload) => emit("turn.started", payload));
  agent.bus.on("turn.delta", (payload) => emit("turn.delta", payload));
  agent.bus.on("tool.started", (payload) => emit("tool.started", payload));
  agent.bus.on("tool.output", (payload) => emit("tool.output", payload));
  agent.bus.on("tool.finished", (payload) => emit("tool.finished", payload));
  agent.bus.on("turn.completed", (payload) => emit("turn.completed", payload));
  agent.bus.on("turn.interrupted", (payload) => emit("turn.interrupted", payload));

  try {
    const final = await agent.send(options.prompt);
    if (!options.json) print(messageText(final));
    await persistSession(options, agent.history());
    await diagnostics?.flush();
    return final;
  } finally {
    await mcp?.stop();
  }
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

async function persistSession(options: RunOptions, history: readonly Message[]): Promise<void> {
  if (options.sessionDir === undefined) return;
  const file = join(options.sessionDir, newSessionFileName());
  const store = await SessionStore.create(file, options.cwd);
  for (const message of history) await store.append(message);
}
