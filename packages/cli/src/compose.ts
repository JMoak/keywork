import { homedir } from "node:os";
import { join } from "node:path";
import {
  Agent,
  type AgentDefinition,
  buildSystemPrompt,
  Checkpoints,
  coreTools,
  type EngineEvents,
  type EventBus,
  loadProjectInstructions,
  McpRegistry,
  MemoryFlush,
  type Message,
  narrowedPermissions,
  type PermissionResolver,
  type Provider,
  restrictTools,
  skillTool,
  type Tool,
  type ToolGuard,
} from "@keywork/engine";
import type { McpServerConfig, PromptsConfig } from "@keywork/shared";
import { loadWorkspaceExtensions, type WorkspaceExtensions } from "./commands.ts";
import {
  bootstrapInjection,
  memoryRecall,
  openWorkspaceMemory,
  type SessionKey,
  type WorkspaceMemory,
  withMemoryPrompt,
} from "./memory.ts";
import { snapshotGitDir } from "./paths.ts";

export interface CompositionOptions {
  cwd: string;
  projectTrusted: boolean;
  prompts?: PromptsConfig | undefined;
  modelId?: string | undefined;
  mcpServers?: Record<string, McpServerConfig> | undefined;
  reportCheckpointsUnavailable?: (message: string) => void;
  userRoot?: string;
  checkpointsGitDir?: string;
}

export interface Composition {
  cwd: string;
  systemPrompt: string;
  memory: WorkspaceMemory | undefined;
  checkpoints: Checkpoints | undefined;
  extensions: WorkspaceExtensions;
  mcp: McpRegistry | undefined;
}

export async function composeWorkspace(options: CompositionOptions): Promise<Composition> {
  const { cwd, projectTrusted } = options;
  const instructions = projectTrusted ? await loadProjectInstructions(cwd) : undefined;
  const memory = openWorkspaceMemory(cwd, projectTrusted);
  const systemPrompt = withMemoryPrompt(
    buildSystemPrompt({
      ...(instructions !== undefined && { projectInstructions: instructions }),
      ...(options.prompts !== undefined && { prompts: options.prompts }),
      ...(options.modelId !== undefined && { modelId: options.modelId }),
    }),
    await bootstrapInjection(memory),
  );
  const checkpoints = await Checkpoints.open({
    worktree: cwd,
    gitDir: options.checkpointsGitDir ?? snapshotGitDir(cwd),
  }).catch((cause: unknown) => {
    options.reportCheckpointsUnavailable?.((cause as Error).message);
    return undefined;
  });
  const extensions = await loadWorkspaceExtensions(
    cwd,
    projectTrusted,
    options.userRoot ?? join(homedir(), ".keywork"),
  );
  const mcp = startMcpRegistry(options.mcpServers);
  return { cwd, systemPrompt, memory, checkpoints, extensions, mcp };
}

export interface AgentCompositionOptions {
  provider: Provider;
  permissions?: PermissionResolver | undefined;
}

export interface AgentBuildSpec {
  guard: ToolGuard;
  definition?: AgentDefinition | undefined;
  history?: readonly Message[] | undefined;
  bus?: EventBus<EngineEvents> | undefined;
  sessionId?: SessionKey | undefined;
  onRetrieval?: ((disclosure: string) => void) | undefined;
}

export interface AgentComposition {
  build(spec: AgentBuildSpec): Agent;
  flushFor(sessionId: string): MemoryFlush | undefined;
  release(sessionId: string): void;
}

export function composeAgents(
  composition: Composition,
  options: AgentCompositionOptions,
): AgentComposition {
  const skillTools =
    composition.extensions.skills.length > 0 ? [skillTool(composition.extensions.skills)] : [];
  const flushes = new Map<string, MemoryFlush>();
  return {
    build: (spec) => buildAgent(composition, options, skillTools, spec),
    flushFor: (sessionId) => {
      if (composition.memory === undefined) return undefined;
      const existing = flushes.get(sessionId);
      if (existing !== undefined) return existing;
      const flush = new MemoryFlush({
        provider: options.provider,
        store: composition.memory.store,
        systemPrompt: composition.systemPrompt,
      });
      flushes.set(sessionId, flush);
      return flush;
    },
    release: (sessionId) => {
      flushes.delete(sessionId);
    },
  };
}

export function startMcpRegistry(
  servers: Record<string, McpServerConfig> | undefined,
): McpRegistry | undefined {
  if (servers === undefined || Object.keys(servers).length === 0) return undefined;
  const registry = new McpRegistry({ servers });
  registry.start();
  return registry;
}

function buildAgent(
  composition: Composition,
  options: AgentCompositionOptions,
  skillTools: readonly Tool[],
  spec: AgentBuildSpec,
): Agent {
  let self: Agent | undefined;
  const baseTools = [
    ...coreTools(
      composition.cwd,
      memoryRecall(composition.memory, spec.sessionId, spec.onRetrieval),
      (chunk) => self?.bus.emit("tool.output", { chunk }),
    ),
    ...skillTools,
  ];
  const tools = composition.mcp === undefined ? baseTools : composition.mcp.surface(baseTools);
  const definition = spec.definition;
  const permissions =
    definition === undefined
      ? options.permissions
      : narrowedPermissions(definition, options.permissions);
  const agent = new Agent({
    provider: options.provider,
    tools: definition === undefined ? tools : restrictTools(tools, definition),
    systemPrompt:
      definition === undefined || definition.prompt === ""
        ? composition.systemPrompt
        : definition.prompt,
    guard: spec.guard,
    ...(permissions !== undefined && { permissions }),
    ...(spec.history !== undefined && { history: spec.history }),
    ...(spec.bus !== undefined && { bus: spec.bus }),
  });
  self = agent;
  return agent;
}
