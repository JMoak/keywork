import { homedir } from "node:os";
import {
  type AfterSave,
  Agent,
  actionRecallBudget,
  type BootstrapInjection,
  type BotDefinition,
  buildSystemPrompt,
  Checkpoints,
  type ContextInjection,
  composeAfterSave,
  contextBudgetFor,
  coreTools,
  type DiagnosticsLog,
  type DiagnosticsPublication,
  declaredContextWindow,
  diagnosticsObserver,
  type EngineEvents,
  type EventBus,
  type LanguagePort,
  type LanguageServerSetting,
  languagePort,
  languageServersFor,
  loadProjectInstructions,
  McpRegistry,
  MemoryFlush,
  type MemoryRecall,
  type Message,
  memoryRecallTools,
  messageText,
  narrowedPermissions,
  type PermissionResolver,
  type Provider,
  pointOfActionRecall,
  RepoMap,
  repoMapTokenBudget,
  restrictTools,
  type ShellSession,
  skillTool,
  type Tool,
  type ToolGuard,
  type ToolScope,
  toolScope,
} from "@keywork/engine";
import type { McpServerConfig, ModelCapabilitiesConfig, PromptsConfig } from "@keywork/shared";
import { mostSpecificMatch, openWorkspace, resolveAnchor, toError } from "@keywork/shared";
import type { ArcService } from "./arcs.ts";
import type { BotLearning, BotMemory } from "./bot-memory.ts";
import { loadWorkspaceExtensions, type WorkspaceExtensions } from "./commands.ts";
import {
  bootstrapInjection,
  type CitationTrail,
  type MemoryAccess,
  memoryRecall,
  resolveSessionKey,
  type SessionKey,
  withMemoryPrompt,
  workspaceMemoryAccess,
} from "./memory.ts";
import { snapshotGitDir } from "./paths.ts";

export interface CompositionOptions {
  cwd: string;
  projectTrusted: boolean;
  workspaceSlug?: string | undefined;
  prompts?: PromptsConfig | undefined;
  mcpServers?: Record<string, McpServerConfig> | undefined;
  repoMap?: "auto" | "off" | undefined;
  models?: ModelCapabilitiesConfig | undefined;
  lsp?: LanguageServerSetting | undefined;
  onFileSaved?: ((path: string) => void) | undefined;
  notice?: ((text: string) => void) | undefined;
  diagnosticsLog?: (() => Pick<DiagnosticsLog, "log"> | undefined) | undefined;
  checkpoints?: "on" | "off";
  reportCheckpointsUnavailable?: ((message: string) => void) | undefined;
  userRoot?: string | undefined;
  checkpointsGitDir?: string | undefined;
}

export interface Composition {
  cwd: string;
  scope: ToolScope;
  systemPromptFor(modelId: string | undefined): string;
  systemPromptWith(modelId: string | undefined, memoryInjection: string): string;
  standingInjections: readonly ContextInjection[];
  memory: MemoryAccess;
  bootstrap: BootstrapInjection | undefined;
  checkpoints: Checkpoints | undefined;
  extensions: WorkspaceExtensions;
  mcp: McpRegistry | undefined;
  repoMap: RepoMap | undefined;
  languagePort: LanguagePort | undefined;
  afterSave: AfterSave | undefined;
  afterSaveFor(onPublished: (publication: DiagnosticsPublication) => void): AfterSave | undefined;
}

export async function composeWorkspace(options: CompositionOptions): Promise<Composition> {
  const { cwd, projectTrusted, workspaceSlug } = options;
  const instructions = projectTrusted ? await loadProjectInstructions(cwd) : undefined;
  const memory = workspaceMemoryAccess(cwd, projectTrusted, workspaceSlug);
  const bootstrap = await bootstrapInjection(memory());
  const repoMap = await openRepoMap(cwd, projectTrusted, options.repoMap);
  const systemPromptWith = (modelId: string | undefined, memoryInjection: string): string => {
    const map = repoMapPrompt(repoMap, options.models, modelId);
    return withMemoryPrompt(
      buildSystemPrompt({
        ...(instructions !== undefined && { projectInstructions: instructions }),
        ...(options.prompts !== undefined && { prompts: options.prompts }),
        ...(modelId !== undefined && { modelId }),
        ...(map !== undefined && { repoMap: map }),
      }),
      memoryInjection,
    );
  };
  const systemPromptFor = (modelId: string | undefined): string =>
    systemPromptWith(modelId, bootstrap?.text ?? "");
  const checkpoints = options.checkpoints === "off" ? undefined : await openCheckpoints(options);
  const extensions = await loadWorkspaceExtensions(
    cwd,
    projectTrusted,
    options.userRoot ?? homedir(),
  );
  const mcp = startMcpRegistry(options.mcpServers);
  const scope = workspaceToolScope(cwd, projectTrusted, workspaceSlug);
  const port = openLanguagePort(scope, options);
  const afterSaveFor = (onPublished: (publication: DiagnosticsPublication) => void) =>
    composeAfterSave(
      [
        refreshingOnSave(repoMap, options.onFileSaved),
        port === undefined ? undefined : diagnosticsObserver(port, { cwd, onPublished }),
      ],
      {
        onFailure: (error, path) =>
          options.diagnosticsLog?.()?.log("error", "afterSave.failed", { path, error }),
      },
    );
  return {
    cwd,
    scope,
    systemPromptFor,
    systemPromptWith,
    standingInjections: standingInjectionsFor(instructions, bootstrap?.text ?? "", repoMap),
    memory,
    bootstrap,
    checkpoints,
    extensions,
    mcp,
    repoMap,
    languagePort: port,
    afterSave: afterSaveFor(() => undefined),
    afterSaveFor,
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

export interface AgentCompositionOptions {
  permissions?: PermissionResolver | undefined;
  arcs?: ArcService | undefined;
  bots?: BotMemory | undefined;
  citations?: CitationTrail | undefined;
  thinking?: boolean | undefined;
}

export interface AgentBuildSpec {
  provider: Provider;
  guard: ToolGuard;
  bot?: BotDefinition | undefined;
  history?: readonly Message[] | undefined;
  bus?: EventBus<EngineEvents> | undefined;
  sessionId?: SessionKey | undefined;
  onRetrieval?: ((disclosure: string) => void) | undefined;
  shell?: ShellSession | undefined;
}

export interface AgentComposition {
  build(spec: AgentBuildSpec): Agent;
  flushFor(sessionId: string, provider: Provider): MemoryFlush | undefined;
  flushOf(sessionId: string): MemoryFlush | undefined;
  providerOf(sessionId: string): Provider | undefined;
  release(sessionId: string): void;
}

export function composeAgents(
  composition: Composition,
  options: AgentCompositionOptions = {},
): AgentComposition {
  const flushes = new Map<string, MemoryFlush>();
  const providers = new Map<string, Provider>();
  const replyTapped = new WeakSet<EventBus<EngineEvents>>();
  return {
    build: (spec) => buildAgent(composition, options, spec, replyTapped),
    flushFor: (sessionId, provider) => {
      const memory = composition.memory();
      if (memory === undefined) return undefined;
      providers.set(sessionId, provider);
      const existing = flushes.get(sessionId);
      if (existing !== undefined) return existing;
      const workspaceStore = memory.store;
      const flush = new MemoryFlush({
        provider: followingProvider(() => providers.get(sessionId) ?? provider),
        store: workspaceStore,
        dailyStore: () => options.arcs?.layerStoreFor(sessionId) ?? workspaceStore,
        bot: () => options.bots?.flushTarget(sessionId),
        systemPrompt: composition.systemPromptFor(undefined),
      });
      flushes.set(sessionId, flush);
      return flush;
    },
    flushOf: (sessionId) => flushes.get(sessionId),
    providerOf: (sessionId) => providers.get(sessionId),
    release: (sessionId) => {
      flushes.delete(sessionId);
      providers.delete(sessionId);
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

function openCheckpoints(options: CompositionOptions): Promise<Checkpoints | undefined> {
  return Checkpoints.open({
    worktree: options.cwd,
    gitDir: options.checkpointsGitDir ?? snapshotGitDir(options.cwd, options.workspaceSlug),
  }).catch((cause: unknown) => {
    options.reportCheckpointsUnavailable?.(toError(cause).message);
    return undefined;
  });
}

function standingInjectionsFor(
  projectInstructions: string | undefined,
  bootstrap: string,
  repoMap: RepoMap | undefined,
): ContextInjection[] {
  const mappedFiles = repoMap?.facts().files ?? 0;
  const mappedLabel = mappedFiles === 1 ? "1 file" : `${mappedFiles} files`;
  return [
    ...(projectInstructions === undefined
      ? []
      : [{ source: "project-instructions" as const, id: "AGENTS.md" }]),
    ...(bootstrap === "" ? [] : [{ source: "memory-bootstrap" as const, scope: "workspace" }]),
    ...(mappedFiles === 0
      ? []
      : [{ source: "repo-map" as const, id: mappedLabel, scope: "workspace" }]),
  ];
}

async function openRepoMap(
  cwd: string,
  projectTrusted: boolean,
  setting: "auto" | "off" | undefined,
): Promise<RepoMap | undefined> {
  if (!projectTrusted || setting === "off") return undefined;
  const map = new RepoMap({ root: cwd });
  await map.build();
  return map;
}

function repoMapPrompt(
  map: RepoMap | undefined,
  models: ModelCapabilitiesConfig | undefined,
  modelId: string | undefined,
): string | undefined {
  if (map === undefined) return undefined;
  const window = mostSpecificMatch(models, modelId)?.contextWindow;
  const rendered = map.serialize(repoMapTokenBudget(window));
  return rendered === "" ? undefined : rendered;
}

function refreshingOnSave(
  map: RepoMap | undefined,
  onFileSaved: ((path: string) => void) | undefined,
): AfterSave | undefined {
  if (map === undefined && onFileSaved === undefined) return undefined;
  return async (path) => {
    map?.markStale();
    void map?.refreshIfStale();
    onFileSaved?.(path);
    return undefined;
  };
}

function openLanguagePort(scope: ToolScope, options: CompositionOptions): LanguagePort | undefined {
  const servers = languageServersFor(options.lsp);
  if (!options.projectTrusted || Object.keys(servers).length === 0) return undefined;
  return languagePort(scope, {
    servers,
    diagnostics: {
      log: (level, event, payload) => options.diagnosticsLog?.()?.log(level, event, payload),
    },
    onMissing: (language) =>
      options.notice?.(
        `no ${language} language server on PATH · diagnostics off for ${servers[language]?.extensions.join(" ") ?? language}`,
      ),
  });
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

function buildAgent(
  composition: Composition,
  options: AgentCompositionOptions,
  spec: AgentBuildSpec,
  replyTapped: WeakSet<EventBus<EngineEvents>>,
): Agent {
  let self: Agent | undefined;
  const recall = journalingRecall(
    memoryRecall(
      composition.memory(),
      spec.sessionId,
      spec.onRetrieval,
      options.arcs,
      options.bots,
    ),
    () => self,
  );
  const tap = options.citations?.tapFor(spec.sessionId);
  const baseTools = [
    ...coreTools(composition.scope, {
      shell: spec.shell,
      onToolOutput: (chunk) => self?.bus.emit("tool.output", { chunk }),
      afterSave: composition.afterSaveFor((publication) =>
        self?.bus.emit("diagnostics.published", publication),
      ),
    }),
    ...(recall === undefined
      ? []
      : memoryRecallTools(recall.store, recall.search, recall.onRecall, tap)),
    ...skillToolsFor(composition, () => self),
  ];
  const tools =
    composition.mcp === undefined ? () => baseTools : composition.mcp.surface(baseTools);
  const bot = spec.bot;
  const permissions =
    bot === undefined ? options.permissions : narrowedPermissions(bot, options.permissions);
  const learning = bot === undefined ? undefined : options.bots?.bootstrapFor(bot);
  const prompt = promptFor(composition, spec.provider.modelId, bot, learning);
  const agent = new Agent({
    provider: spec.provider,
    tools: bot === undefined ? tools : () => restrictTools(tools(), bot),
    systemPrompt: prompt.systemPrompt,
    standingInjections: prompt.standingInjections,
    guard: spec.guard,
    ...(options.thinking === true && { thinking: true }),
    ...(permissions !== undefined && { permissions }),
    ...(spec.history !== undefined && { history: spec.history }),
    ...(spec.bus !== undefined && { bus: spec.bus }),
    ...(recall !== undefined && {
      actionRecall: pointOfActionRecall({
        search: recall.search,
        tokens: actionRecallBudget(contextBudgetFor(declaredContextWindow(spec.provider))),
        ...(tap !== undefined && { tap }),
        onRecall: (noteName) =>
          self?.bus.emit("context.injected", {
            injection: { source: "memory-action", id: noteName, scope: "workspace" },
          }),
      }),
    }),
  });
  self = agent;
  wireReplyCitations(agent, options.citations, spec.sessionId, replyTapped);
  wireBootstrapCitations(agent, options.citations, spec.sessionId, prompt.bootstrap);
  return agent;
}

interface ComposedPrompt {
  systemPrompt: string;
  standingInjections: readonly ContextInjection[];
  bootstrap?: BootstrapInjection;
}

function promptFor(
  composition: Composition,
  modelId: string | undefined,
  bot: BotDefinition | undefined,
  learning: BotLearning | undefined,
): ComposedPrompt {
  const composed = bot === undefined || bot.prompt === "";
  if (learning === undefined || bot === undefined) {
    return composed
      ? {
          systemPrompt: composition.systemPromptFor(modelId),
          standingInjections: composition.standingInjections,
        }
      : { systemPrompt: bot.prompt, standingInjections: [] };
  }
  const botInjection: ContextInjection = { source: "memory-bootstrap", scope: `bot:${bot.name}` };
  const announced = learning.own.text === "" ? [] : [botInjection];
  return composed
    ? {
        systemPrompt: composition.systemPromptWith(modelId, learning.composed.text),
        standingInjections: [...composition.standingInjections, ...announced],
        bootstrap: learning.composed,
      }
    : {
        systemPrompt: withMemoryPrompt(bot.prompt, learning.own.text),
        standingInjections: announced,
        bootstrap: learning.own,
      };
}

function wireBootstrapCitations(
  agent: Agent,
  citations: CitationTrail | undefined,
  sessionKey: SessionKey | undefined,
  bootstrap: BootstrapInjection | undefined,
): void {
  if (citations === undefined || sessionKey === undefined || bootstrap === undefined) return;
  let recorded = false;
  agent.bus.on("turn.started", () => {
    if (recorded) return;
    const id = resolveSessionKey(sessionKey);
    if (id === undefined) return;
    recorded = true;
    citations.recordBootstrap(id, bootstrap);
  });
}

function wireReplyCitations(
  agent: Agent,
  citations: CitationTrail | undefined,
  sessionKey: SessionKey | undefined,
  replyTapped: WeakSet<EventBus<EngineEvents>>,
): void {
  if (citations === undefined || sessionKey === undefined) return;
  if (replyTapped.has(agent.bus)) return;
  replyTapped.add(agent.bus);
  agent.bus.on("turn.completed", ({ message, replay }) => {
    if (replay === true) return;
    const id = resolveSessionKey(sessionKey);
    if (id !== undefined) citations.recordReply(id, messageText(message));
  });
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

function skillToolsFor(composition: Composition, agent: () => Agent | undefined): Tool[] {
  if (composition.extensions.skills.length === 0) return [];
  return [
    skillTool(composition.extensions.skills, (skill) =>
      agent()?.bus.emit("context.injected", { injection: { source: "skill", id: skill.name } }),
    ),
  ];
}
