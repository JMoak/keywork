import { homedir } from "node:os";
import { join } from "node:path";
import {
  Agent,
  type AgentDefinition,
  buildSystemPrompt,
  Checkpoints,
  type ContextInjection,
  coreTools,
  type EngineEvents,
  type EventBus,
  loadProjectInstructions,
  McpRegistry,
  MemoryFlush,
  type MemoryRecall,
  type Message,
  narrowedPermissions,
  type PermissionResolver,
  type Provider,
  restrictTools,
  skillTool,
  type Tool,
  type ToolGuard,
  type ToolScope,
  toolScope,
} from "@keywork/engine";
import type { McpServerConfig, PromptsConfig } from "@keywork/shared";
import { openWorkspace, resolveAnchor } from "@keywork/shared";
import type { ArcService } from "./arcs.ts";
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
  workspaceSlug?: string | undefined;
  prompts?: PromptsConfig | undefined;
  mcpServers?: Record<string, McpServerConfig> | undefined;
  onFileSaved?: ((path: string) => void) | undefined;
  reportCheckpointsUnavailable?: (message: string) => void;
  userRoot?: string;
  checkpointsGitDir?: string;
}

export interface Composition {
  cwd: string;
  scope: ToolScope;
  systemPromptFor(modelId: string | undefined): string;
  standingInjections: readonly ContextInjection[];
  memory: WorkspaceMemory | undefined;
  checkpoints: Checkpoints | undefined;
  extensions: WorkspaceExtensions;
  mcp: McpRegistry | undefined;
  onFileSaved: ((path: string) => void) | undefined;
}

export async function composeWorkspace(options: CompositionOptions): Promise<Composition> {
  const { cwd, projectTrusted, workspaceSlug } = options;
  const instructions = projectTrusted ? await loadProjectInstructions(cwd) : undefined;
  const memory = openWorkspaceMemory(cwd, projectTrusted, workspaceSlug);
  const bootstrap = await bootstrapInjection(memory);
  const systemPromptFor = (modelId: string | undefined): string =>
    withMemoryPrompt(
      buildSystemPrompt({
        ...(instructions !== undefined && { projectInstructions: instructions }),
        ...(options.prompts !== undefined && { prompts: options.prompts }),
        ...(modelId !== undefined && { modelId }),
      }),
      bootstrap,
    );
  const checkpoints = await Checkpoints.open({
    worktree: cwd,
    gitDir: options.checkpointsGitDir ?? snapshotGitDir(cwd, workspaceSlug),
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
  return {
    cwd,
    scope: workspaceToolScope(cwd, projectTrusted, workspaceSlug),
    systemPromptFor,
    standingInjections: standingInjectionsFor(instructions, bootstrap),
    memory,
    checkpoints,
    extensions,
    mcp,
    onFileSaved: options.onFileSaved,
  };
}

export function workspaceToolScope(
  cwd: string,
  projectTrusted: boolean,
  workspaceSlug?: string,
): ToolScope {
  const anchorRoot = resolveAnchor(cwd).root;
  const linkedDirs = projectTrusted ? (openWorkspace(cwd, workspaceSlug)?.contextDirs ?? []) : [];
  return toolScope(cwd, [anchorRoot, ...linkedDirs]);
}

export function standingInjectionsFor(
  projectInstructions: string | undefined,
  bootstrap: string,
): ContextInjection[] {
  return [
    ...(projectInstructions === undefined
      ? []
      : [{ source: "project-instructions" as const, id: "AGENTS.md" }]),
    ...(bootstrap === "" ? [] : [{ source: "memory-bootstrap" as const, scope: "workspace" }]),
  ];
}

export function journalingRecall(
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

export interface AgentCompositionOptions {
  permissions?: PermissionResolver | undefined;
  arcs?: ArcService | undefined;
}

export interface AgentBuildSpec {
  provider: Provider;
  guard: ToolGuard;
  definition?: AgentDefinition | undefined;
  history?: readonly Message[] | undefined;
  bus?: EventBus<EngineEvents> | undefined;
  sessionId?: SessionKey | undefined;
  onRetrieval?: ((disclosure: string) => void) | undefined;
}

export interface AgentComposition {
  build(spec: AgentBuildSpec): Agent;
  flushFor(sessionId: string, provider: Provider): MemoryFlush | undefined;
  release(sessionId: string): void;
}

export function composeAgents(
  composition: Composition,
  options: AgentCompositionOptions = {},
): AgentComposition {
  const flushes = new Map<string, MemoryFlush>();
  const providers = new Map<string, Provider>();
  return {
    build: (spec) => buildAgent(composition, options, spec),
    flushFor: (sessionId, provider) => {
      if (composition.memory === undefined) return undefined;
      providers.set(sessionId, provider);
      const existing = flushes.get(sessionId);
      if (existing !== undefined) return existing;
      const workspaceStore = composition.memory.store;
      const flush = new MemoryFlush({
        provider: followingProvider(() => providers.get(sessionId) ?? provider),
        store: workspaceStore,
        dailyStore: () => options.arcs?.layerStoreFor(sessionId) ?? workspaceStore,
        systemPrompt: composition.systemPromptFor(undefined),
      });
      flushes.set(sessionId, flush);
      return flush;
    },
    release: (sessionId) => {
      flushes.delete(sessionId);
      providers.delete(sessionId);
    },
  };
}

function followingProvider(current: () => Provider): Provider {
  return {
    get name() {
      return current().name;
    },
    get modelId() {
      return current().modelId;
    },
    get capabilities() {
      return current().capabilities;
    },
    stream: (request) => current().stream(request),
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
  spec: AgentBuildSpec,
): Agent {
  let self: Agent | undefined;
  const skillTools = skillToolsFor(composition, () => self);
  const baseTools = [
    ...coreTools(
      composition.scope,
      journalingRecall(
        memoryRecall(composition.memory, spec.sessionId, spec.onRetrieval, options.arcs),
        () => self,
      ),
      {
        onToolOutput: (chunk) => self?.bus.emit("tool.output", { chunk }),
        onFileSaved: composition.onFileSaved,
      },
    ),
    ...skillTools,
  ];
  const tools = composition.mcp === undefined ? baseTools : composition.mcp.surface(baseTools);
  const definition = spec.definition;
  const permissions =
    definition === undefined
      ? options.permissions
      : narrowedPermissions(definition, options.permissions);
  const composedPrompt = definition === undefined || definition.prompt === "";
  const agent = new Agent({
    provider: spec.provider,
    tools: definition === undefined ? tools : restrictTools(tools, definition),
    systemPrompt: composedPrompt
      ? composition.systemPromptFor(spec.provider.modelId)
      : definition.prompt,
    standingInjections: composedPrompt ? composition.standingInjections : [],
    guard: spec.guard,
    ...(permissions !== undefined && { permissions }),
    ...(spec.history !== undefined && { history: spec.history }),
    ...(spec.bus !== undefined && { bus: spec.bus }),
  });
  self = agent;
  return agent;
}

function skillToolsFor(composition: Composition, agent: () => Agent | undefined): Tool[] {
  if (composition.extensions.skills.length === 0) return [];
  return [
    skillTool(composition.extensions.skills, (skill) =>
      agent()?.bus.emit("context.injected", { injection: { source: "skill", id: skill.name } }),
    ),
  ];
}
