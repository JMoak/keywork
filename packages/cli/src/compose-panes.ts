import {
  type Agent,
  type ContextBudget,
  compactNow,
  contextBudgetFor,
  declaredContextWindow,
  renderCommand,
  type SessionStore,
  scanTemplate,
  settleTurn,
  suggestTitle,
  tapJournal,
} from "@keywork/engine";
import type { KeyworkConfig } from "@keywork/shared";
import {
  type AfterTurn,
  type AgentFactory,
  type AppOptions,
  type Compactor,
  type ExtensionsPort,
  runApp,
  type WorkspacePort,
  type WorkspacesPort,
} from "@keywork/tui";
import { arcService } from "./arcs.ts";
import { commandRuntime, type WorkspaceExtensions } from "./commands.ts";
import {
  type AgentComposition,
  type Composition,
  composeAgents,
  composeWorkspace,
} from "./compose.ts";
import { inferencePort } from "./inference/port.ts";
import type { LiveInference } from "./inference-state.ts";
import { type DeferredMaterialization, deferredMaterialization } from "./materialize.ts";
import { mcpPanePort } from "./mcp.ts";
import { memoryPanePort, sweepOnClose } from "./memory.ts";
import { defaultSessionDir, workspaceIdentity, workspaceStateFile } from "./paths.ts";
import { type PresetSwitch, presetsPortFor } from "./presets.ts";
import {
  boundSessionCounts,
  sessionChangeFeed,
  sessionPort,
  sessionTreePort,
} from "./sessions/ports.ts";
import { freshWorkspace, workspaceFile } from "./workspace.ts";
import { type WorkspaceRecall, workspacesPort } from "./workspaces.ts";

export interface PanesLaunch {
  cwd: string;
  projectTrusted: boolean;
  workspaceSlug: string | undefined;
  workspaceRecall: WorkspaceRecall;
  inference: LiveInference;
  presets: PresetSwitch;
  sessionDir?: string | undefined;
  fresh?: boolean | undefined;
  modelOverride?: string | undefined;
}

export interface PanesSeams {
  createRenderer?: AppOptions["createRenderer"];
  exit?: (code: number) => void;
  switchWorkspace?: (slug: string | undefined) => void;
}

export async function openPanes(launch: PanesLaunch, seams: PanesSeams = {}): Promise<void> {
  const { cwd, projectTrusted, workspaceSlug } = launch;
  let pendingSwitch: { slug: string | undefined } | undefined;
  const app = await composePanes({
    cwd,
    projectTrusted,
    workspaceSlug,
    sessionDir: launch.sessionDir ?? defaultSessionDir(cwd, workspaceSlug),
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
      requestSwitch: (next) => {
        pendingSwitch = { slug: next };
      },
    }),
  });
  const exit = seams.exit ?? ((code: number) => process.exit(code));
  await runApp({
    ...app,
    ...(seams.createRenderer !== undefined && { createRenderer: seams.createRenderer }),
    exit: (code) => {
      if (pendingSwitch !== undefined && seams.switchWorkspace !== undefined) {
        seams.switchWorkspace(pendingSwitch.slug);
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
  modelOverride?: string | undefined;
  materialize?: DeferredMaterialization | undefined;
  userRoot?: string | undefined;
  checkpointsGitDir?: string | undefined;
  reportCheckpointsUnavailable?: ((message: string) => void) | undefined;
}

export async function composePanes(options: PanesOptions): Promise<AppOptions> {
  const { cwd, projectTrusted, workspaceSlug, config, materialize, presets } = options;
  const composition = await composeWorkspace({
    cwd,
    projectTrusted,
    workspaceSlug,
    prompts: config.prompts,
    mcpServers: config.mcpServers,
    onFileSaved: materialize === undefined ? undefined : (path) => materialize.fileSaved(path),
    userRoot: options.userRoot,
    checkpointsGitDir: options.checkpointsGitDir,
    reportCheckpointsUnavailable: options.reportCheckpointsUnavailable,
  });
  const { checkpoints, extensions, mcp, memory } = composition;
  const arcs = arcService({
    cwd,
    trusted: projectTrusted,
    workspaceSlug,
    memory: () => memory,
    boundSessionCounts: () => boundSessionCounts(options.sessionDir),
  });
  const agents = composeAgents(composition, { permissions: presets?.resolver, arcs });
  const stores = new Map<string, SessionStore>();
  const changes = sessionChangeFeed();
  return {
    workspace: options.workspace,
    sessions: sessionPort(options.sessionDir, cwd, {
      checkpointTag: () => checkpoints?.takeTurnTag(),
      onAttach: (store) => {
        stores.set(store.header.id, store);
        arcs.attached(store);
      },
      onRelease: (sessionId) => {
        stores.delete(sessionId);
        agents.release(sessionId);
        arcs.released(sessionId);
      },
      onChange: (sessionId) => changes.emit(sessionId),
      onArcBound: (sessionId, arc) => arcs.recordBinding(sessionId, arc),
    }),
    sessionTrees: sessionTreePort(options.sessionDir, changes),
    arcs: arcs.port,
    afterTurn: settleAfterTurn(stores, agents, changes.emit),
    compact: compactOnRequest(stores, agents, changes.emit),
    closers: [() => sweepOnClose(memory), ...(mcp === undefined ? [] : [() => mcp.stop()])],
    extensions: extensionsView(extensions, cwd),
    ...(config.theme !== undefined && { themeOverrides: config.theme }),
    ...(config.page !== undefined && { page: config.page }),
    ...(checkpoints !== undefined && { checkpoints }),
    ...(memory !== undefined && { memory: memoryPanePort(memory) }),
    ...(mcp !== undefined && { mcp: mcpPanePort(mcp) }),
    ...(options.workspaces !== undefined && { workspaces: options.workspaces }),
    ...(presets !== undefined && {
      presets: presetsPortFor(presets),
      statusLabel: () => presets.active(),
    }),
    ...(options.inference !== undefined &&
      inferenceSeams(options.inference, options, composition, agents, stores)),
  };
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
  const agentFactory: AgentFactory = (guard, history, seams, agentName) => {
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
      definition: composition.extensions.agents.find((candidate) => candidate.name === agentName),
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
    agents: extensions.agents.map((agent) => ({
      name: agent.name,
      ...(agent.description !== undefined && { description: agent.description }),
    })),
    failures: extensions.failures.map((failure) => `${failure.file}: ${failure.reason}`),
  };
}
