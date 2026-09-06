import { homedir } from "node:os";
import {
  type Agent,
  type BotDefinition,
  type ContextBudget,
  type CurationJudgmentPort,
  closingJudgment,
  compactNow,
  contextBudgetFor,
  declaredContextWindow,
  type MemoryFlush,
  type Provider,
  renderCommand,
  type SessionStore,
  scanTemplate,
  settleTurn,
  suggestTitle,
  tapJournal,
} from "@keywork/engine";
import type { KeyworkConfig, TrustStore } from "@keywork/shared";
import {
  type AfterTurn,
  type AgentFactory,
  type AppOptions,
  type Compactor,
  crashLogFacts,
  crashLogFile,
  detectCapabilities,
  type ExtensionsPort,
  type NoticeSource,
  readinessNotice,
  runApp,
  type WorkspacePort,
  type WorkspaceSetupPort,
  type WorkspacesPort,
} from "@keywork/tui";
import { arcService, arcsUnavailable, type ClosingRequest } from "./arcs.ts";
import { botMemory } from "./bot-memory.ts";
import { botService } from "./bots.ts";
import { commandRuntime, type WorkspaceExtensions } from "./commands.ts";
import {
  type AgentComposition,
  type Composition,
  composeAgents,
  composeWorkspace,
} from "./compose.ts";
import { inferencePort } from "./inference/port.ts";
import { closingRole, namingRole, roleProvider } from "./inference/roles.ts";
import type { LiveInference } from "./inference-state.ts";
import { type DeferredMaterialization, deferredMaterialization } from "./materialize.ts";
import { mcpPanePort } from "./mcp.ts";
import { citationTrail, memoryPanePort, sweepOnClose } from "./memory.ts";
import { defaultSessionDir, workspaceIdentity, workspaceStateFile } from "./paths.ts";
import { type PresetSwitch, presetsPortFor } from "./presets.ts";
import {
  boundSessionCounts,
  sessionChangeFeed,
  sessionPort,
  sessionTreePort,
} from "./sessions/ports.ts";
import { listSessions } from "./sessions/store.ts";
import { freshWorkspace, workspaceFile } from "./workspace.ts";
import { workspaceSetupPort } from "./workspace-setup.ts";
import { type WorkspaceRecall, workspacesPort } from "./workspaces.ts";

export interface PanesLaunch {
  cwd: string;
  projectTrusted: boolean;
  workspaceSlug: string | undefined;
  workspaceRecall: WorkspaceRecall;
  trustStore: TrustStore;
  inference: LiveInference;
  presets: PresetSwitch;
  sessionDir?: string | undefined;
  fresh?: boolean | undefined;
  modelOverride?: string | undefined;
}

export interface PanesSeams {
  createRenderer?: AppOptions["createRenderer"];
  exit?: (code: number) => void;
  reopen?: (slug: string | undefined) => void;
}

export async function openPanes(launch: PanesLaunch, seams: PanesSeams = {}): Promise<void> {
  const { cwd, projectTrusted, workspaceSlug } = launch;
  let pendingReopen: { slug: string | undefined } | undefined;
  const requestReopen = (slug: string | undefined): void => {
    pendingReopen = { slug };
  };
  const sessionDir = launch.sessionDir ?? defaultSessionDir(cwd, workspaceSlug);
  const app = await composePanes({
    cwd,
    projectTrusted,
    workspaceSlug,
    sessionDir,
    workspace: workspaceStateStore(cwd, workspaceSlug, launch.fresh === true),
    config: launch.inference.current().config,
    inference: launch.inference,
    presets: launch.presets,
    modelOverride: launch.modelOverride,
    materialize: deferredMaterialization({ cwd, trusted: projectTrusted }),
    workspaces: workspacesPort({
      cwd,
      current: workspaceSlug,
      recall: launch.workspaceRecall,
      requestSwitch: requestReopen,
      sessionDirFor: (slug) => (slug === workspaceSlug ? sessionDir : defaultSessionDir(cwd, slug)),
    }),
    workspaceSetup: workspaceSetupPort({
      cwd,
      workspaceSlug,
      trustStore: launch.trustStore,
      ...(seams.reopen !== undefined && { requestReopen: () => requestReopen(workspaceSlug) }),
    }),
  });
  const exit = seams.exit ?? ((code: number) => process.exit(code));
  await runApp({
    ...app,
    ...(seams.createRenderer !== undefined && { createRenderer: seams.createRenderer }),
    exit: (code) => {
      if (pendingReopen !== undefined && seams.reopen !== undefined) {
        seams.reopen(pendingReopen.slug);
      } else exit(code);
    },
  });
}

export interface PanesOptions {
  cwd: string;
  projectTrusted: boolean;
  workspaceSlug?: string | undefined;
  sessionDir: string;
  workspace: WorkspacePort;
  config: KeyworkConfig;
  inference?: LiveInference | undefined;
  presets?: PresetSwitch | undefined;
  workspaces?: WorkspacesPort | undefined;
  workspaceSetup?: WorkspaceSetupPort | undefined;
  modelOverride?: string | undefined;
  materialize?: DeferredMaterialization | undefined;
  userRoot?: string | undefined;
  checkpointsGitDir?: string | undefined;
  reportCheckpointsUnavailable?: ((message: string) => void) | undefined;
}

export async function composePanes(options: PanesOptions): Promise<AppOptions> {
  const { cwd, projectTrusted, workspaceSlug, config, materialize, presets } = options;
  const notices = noticeFeed();
  const composition = await composeWorkspace({
    cwd,
    projectTrusted,
    workspaceSlug,
    prompts: config.prompts,
    mcpServers: config.mcpServers,
    repoMap: config.repoMap,
    models: config.models,
    lsp: config.lsp,
    onFileSaved: materialize === undefined ? undefined : (path) => materialize.fileSaved(path),
    notice: notices.post,
    userRoot: options.userRoot,
    checkpointsGitDir: options.checkpointsGitDir,
    reportCheckpointsUnavailable: options.reportCheckpointsUnavailable,
  });
  const { checkpoints, extensions, mcp, memory } = composition;
  const port = composition.languagePort;
  const citations = citationTrail(memory, () => composition.bootstrap);
  const setup = options.workspaceSetup;
  const stores = new Map<string, SessionStore>();
  const changes = sessionChangeFeed();
  const arcs = arcService({
    cwd,
    trusted: projectTrusted,
    workspaceSlug,
    memory,
    boundSessionCounts: () => boundSessionCounts(options.sessionDir),
    flushFor: (sessionId) => airlockFlushFor(stores.get(sessionId), agents.flushOf(sessionId)),
    closing: (request) => closingSeam(request),
    citedNotes: (slug) => citations.citedNotes(slug),
    lastActivity: (slug) => latestArcActivity(options.sessionDir, slug),
    onReleased: (sessionId) => changes.emit(sessionId),
    unavailable:
      setup === undefined ? undefined : () => readinessNotice(setup.readiness()) ?? arcsUnavailable,
  });
  const botLayers = botMemory({
    cwd,
    projectTrusted,
    workspaceSlug,
    userRoot: options.userRoot ?? homedir(),
    memory,
    roster: extensions.bots,
    bindingOf: (sessionId) => stores.get(sessionId)?.botBinding(),
  });
  await botLayers.prepare();
  const agents = composeAgents(composition, {
    permissions: presets?.resolver,
    arcs,
    bots: botLayers,
    citations,
    thinking: config.thinking === "on",
  });
  const bots = botService({
    cwd,
    projectTrusted,
    userRoot: options.userRoot ?? homedir(),
    sessionDir: options.sessionDir,
    roster: extensions.bots,
    namer: () => namingProvider(options),
  });
  const closingProvider = (sessionIds: readonly string[]): Provider | undefined => {
    const state = options.inference?.current();
    const fromRole =
      state === undefined ? undefined : roleProvider(state.runtime, state.config, closingRole);
    if (fromRole !== undefined) return fromRole;
    return sessionIds
      .map((sessionId) => agents.providerOf(sessionId))
      .find((provider) => provider !== undefined);
  };
  const closingProviderFor = (arc: string): Provider | undefined =>
    closingProvider(arcs.bindings.sessionsBoundTo(arc));
  const closingSeam = (request: ClosingRequest): CurationJudgmentPort | undefined => {
    const provider = closingProviderFor(request.arc);
    if (provider === undefined) return undefined;
    return closingJudgment({
      provider,
      ...(request.direction !== undefined && { direction: request.direction }),
      onDegrade: request.onDegrade,
    });
  };
  const botJudgment = (bot: BotDefinition): CurationJudgmentPort | undefined => {
    const bound = [...stores.values()]
      .filter((store) => store.botBinding() === bot.name)
      .map((store) => store.header.id);
    const provider = closingProvider(bound);
    return provider === undefined ? undefined : closingJudgment({ provider });
  };
  return {
    workspace: options.workspace,
    sessions: sessionPort(options.sessionDir, cwd, {
      checkpointTag: () => checkpoints?.takeTurnTag(),
      onAttach: (store) => {
        stores.set(store.header.id, store);
        citations.forSession(store.header.id);
        void arcs.attached(store);
      },
      onRelease: (sessionId) => {
        stores.delete(sessionId);
        agents.release(sessionId);
        arcs.released(sessionId);
        citations.release(sessionId);
      },
      onChange: (sessionId) => changes.emit(sessionId),
      onArcBound: (sessionId, arc) => arcs.recordBinding(sessionId, arc),
    }),
    sessionTrees: sessionTreePort(options.sessionDir, changes),
    arcs: arcs.port,
    bots,
    afterTurn: settleAfterTurn(stores, agents, changes.emit),
    compact: compactOnRequest(stores, agents, changes.emit),
    closers: [
      () => sweepOnClose(memory()),
      async () => {
        await botLayers.sweep(botJudgment);
      },
      ...(mcp === undefined ? [] : [() => mcp.stop()]),
      ...(port === undefined ? [] : [() => port.dispose()]),
    ],
    notices,
    extensions: extensionsView(extensions, cwd),
    ...(config.theme !== undefined && { themeOverrides: config.theme }),
    ...(config.pointer !== undefined && { pointer: config.pointer }),
    ...(config.masthead !== undefined && { masthead: config.masthead }),
    ...(config.motion !== undefined && { motion: config.motion }),
    ...(config.tips !== undefined && { tips: config.tips }),
    ...(config.scrim !== undefined && { scrim: config.scrim }),
    ...(config.dim !== undefined && { dim: config.dim }),
    doctorReport: async () => {
      const { doctorReport, renderDoctorReport, workspaceDoctorFacts } = await import(
        "./doctor.ts"
      );
      const facts = await workspaceDoctorFacts(cwd, projectTrusted, config);
      return renderDoctorReport(
        doctorReport(detectCapabilities(), options.inference?.current().runtime.registry, {
          ...facts,
          crashLog: crashLogFacts(crashLogFile),
          ...(composition.languagePort !== undefined && {
            languageServers: composition.languagePort.facts(),
          }),
        }),
      );
    },
    ...(config.page !== undefined && { page: config.page }),
    ...(checkpoints !== undefined && { checkpoints }),
    ...(projectTrusted && {
      memory: memoryPanePort(memory, arcs.registry, arcs.port.airlock, botLayers),
    }),
    ...(mcp !== undefined && { mcp: mcpPanePort(mcp) }),
    ...(options.workspaces !== undefined && { workspaces: options.workspaces }),
    ...(setup !== undefined && { workspaceSetup: setup }),
    ...(presets !== undefined && {
      presets: presetsPortFor(presets),
      statusLabel: () => presets.active(),
    }),
    ...(options.inference !== undefined &&
      inferenceSeams(options.inference, options, composition, agents, stores)),
  };
}

function namingProvider(options: PanesOptions): Provider | undefined {
  const state = options.inference?.current();
  if (state === undefined) return undefined;
  const fromRole = roleProvider(state.runtime, state.config, namingRole);
  if (fromRole !== undefined) return fromRole;
  const resolution = state.runtime.resolve({
    override: options.modelOverride,
    default: state.config.model,
  });
  return resolution.ok ? state.runtime.provider(resolution.binding) : undefined;
}

async function latestArcActivity(sessionDir: string, slug: string): Promise<string | undefined> {
  const { sessions } = await listSessions(sessionDir);
  return sessions
    .filter((session) => session.arc === slug)
    .map((session) => session.lastActivityAt)
    .sort()
    .at(-1);
}

function workspaceStateStore(cwd: string, slug: string | undefined, fresh: boolean): WorkspacePort {
  const store = workspaceFile(workspaceStateFile(workspaceIdentity(cwd, slug)));
  return fresh ? freshWorkspace(store) : store;
}

type InferenceSeams = Required<
  Pick<AppOptions, "agentFactory" | "titler" | "inference" | "connections">
>;

function inferenceSeams(
  inference: LiveInference,
  options: PanesOptions,
  composition: Composition,
  agents: AgentComposition,
  stores: ReadonlyMap<string, SessionStore>,
): InferenceSeams {
  const selection = { override: options.modelOverride, default: options.config.model };
  const agentFactory: AgentFactory = (guard, history, seams, botName) => {
    const bound = inference
      .current()
      .runtime.open({ ...selection, selection: seams?.modelReference });
    const agent = agents.build({
      provider: options.materialize?.wrapProvider(bound.provider) ?? bound.provider,
      guard,
      history,
      bus: seams?.bus,
      sessionId: () => seams?.sessionId(),
      onRetrieval: (disclosure) => seams?.discloseRetrieval(disclosure),
      bot: composition.extensions.bots.find((candidate) => candidate.name === botName),
    });
    tapJournal(agent.bus, () => {
      const sessionId = seams?.sessionId();
      return sessionId === undefined ? undefined : stores.get(sessionId);
    });
    return agent;
  };
  return {
    agentFactory,
    titler: (conversation, agent) => suggestTitle(agent.provider, conversation),
    inference: inferencePort({
      registry: () => inference.current().runtime.registry,
      observations: () => inference.current().observations,
    }),
    connections: inference.connections,
  };
}

function settleAfterTurn(
  stores: ReadonlyMap<string, SessionStore>,
  agents: AgentComposition,
  changed: (sessionId: string) => void,
): AfterTurn {
  return async ({ sessionId, history, agent }) => {
    const store = stores.get(sessionId);
    if (store === undefined) return undefined;
    const settlement = await settleTurn({
      store,
      provider: agent.provider,
      history,
      budget: budgetOf(agent),
      flush: agents.flushFor(sessionId, agent.provider),
    });
    if (settlement.history !== undefined) changed(sessionId);
    return settlement;
  };
}

function compactOnRequest(
  stores: ReadonlyMap<string, SessionStore>,
  agents: AgentComposition,
  changed: (sessionId: string) => void,
): Compactor {
  return async ({ sessionId, agent }, instructions) => {
    const store = stores.get(sessionId);
    if (store === undefined) throw new Error("no session store for this pane");
    const settlement = await compactNow({
      store,
      provider: agent.provider,
      budget: budgetOf(agent),
      instructions,
      flush: agents.flushFor(sessionId, agent.provider),
    });
    if (settlement.history !== undefined) changed(sessionId);
    return settlement;
  };
}

function airlockFlushFor(
  store: SessionStore | undefined,
  flush: MemoryFlush | undefined,
): (() => Promise<unknown>) | undefined {
  if (store === undefined) return undefined;
  if (flush === undefined) return async () => undefined;
  return () => flush.flushNow(store.messages());
}

function budgetOf(agent: Agent): ContextBudget {
  return contextBudgetFor(declaredContextWindow(agent.provider));
}

function extensionsView(extensions: WorkspaceExtensions, cwd: string): ExtensionsPort {
  return {
    commands: extensions.commands.map((command) => ({
      name: command.name,
      ...(command.description !== undefined && { description: command.description }),
      needsArgs: scanTemplate(command.template).some((segment) => segment.kind === "arguments"),
      render: (args, confirmShell) =>
        renderCommand(
          command.template,
          args,
          commandRuntime(cwd, {
            confirm: (call) => confirmShell((call.arguments as { command: string }).command),
          }),
        ),
    })),
    failures: extensions.failures.map((failure) => `${failure.file}: ${failure.reason}`),
  };
}

function noticeFeed(): NoticeSource & { post: (text: string) => void } {
  const posts = new Set<(text: string) => void>();
  return {
    post: (text) => {
      for (const post of posts) post(text);
    },
    subscribe: (post) => {
      posts.add(post);
      return () => posts.delete(post);
    },
  };
}
