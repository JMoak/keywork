import { homedir } from "node:os";
import type { BotDefinition, PermissionResolver, Provider, SessionStore } from "@keywork/engine";
import {
  type LspConfig,
  type McpServerConfig,
  type ModelCapabilitiesConfig,
  type PromptsConfig,
  toError,
} from "@keywork/shared";
import { closingSeamFor, latestArcActivity } from "./arc-seams.ts";
import { type ArcService, arcService } from "./arcs.ts";
import { type BotMemory, botMemory } from "./bot-memory.ts";
import {
  type AgentComposition,
  type Composition,
  closeExtensionHost,
  composeAgents,
  composeWorkspace,
  sessionReasonFor,
} from "./compose.ts";
import { citationTrail } from "./memory.ts";
import { sweepFlushFor } from "./session-settle.ts";
import { boundSessionCounts } from "./sessions/ports.ts";
import {
  botJudgmentFrom,
  sweepWorkspaceOnClose,
  type WorkspaceSweep,
  workspaceSkillEvidence,
} from "./workspace-sweep.ts";

export interface ServedWorkspaceOptions {
  cwd: string;
  projectTrusted: boolean;
  workspaceSlug?: string | undefined;
  sessionDir: string;
  userRoot?: string | undefined;
  provider: Provider;
  closingProvider?: Provider | undefined;
  permissions: PermissionResolver;
  thinking: boolean;
  prompts?: PromptsConfig | undefined;
  mcpServers?: Record<string, McpServerConfig> | undefined;
  repoMap?: "auto" | "off" | undefined;
  models?: ModelCapabilitiesConfig | undefined;
  lsp?: LspConfig | undefined;
  checkpoints: "on" | "off";
  checkpointsGitDir?: string | undefined;
  notice(text: string): void;
  storeOf(sessionId: string): SessionStore | undefined;
  liveStores(): Iterable<SessionStore>;
  onReleased?: ((sessionId: string) => void) | undefined;
}

export interface ServedWorkspace {
  composition: Composition;
  agents: AgentComposition;
  arcs: ArcService;
  bots: BotMemory;
  botNamed(name: string | undefined): BotDefinition | undefined;
  attached(store: SessionStore): Promise<void>;
  released(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

export async function composeServedWorkspace(
  options: ServedWorkspaceOptions,
): Promise<ServedWorkspace> {
  const { cwd, projectTrusted, workspaceSlug, sessionDir, notice } = options;
  const userRoot = options.userRoot ?? homedir();
  const composition = await composeWorkspace({
    cwd,
    projectTrusted,
    workspaceSlug,
    prompts: options.prompts,
    mcpServers: options.mcpServers,
    repoMap: options.repoMap,
    models: options.models,
    checkpoints: options.checkpoints,
    checkpointsGitDir: options.checkpointsGitDir,
    reportCheckpointsUnavailable: (message) => notice(`can't undo files: ${message}`),
    lsp: options.lsp,
    notice,
    userRoot,
  });
  for (const failure of composition.extensions.failures) {
    notice(`skipped extension ${failure.file} · ${failure.reason}`);
  }
  const { memory, extensions, host } = composition;
  const citations = citationTrail(memory, () => composition.bootstrap);
  const closingProviderAmong = (sessionIds: readonly string[]): Provider =>
    options.closingProvider ??
    sessionIds
      .map((sessionId) => agents.providerOf(sessionId))
      .find((provider) => provider !== undefined) ??
    options.provider;
  const closingProviderFor = (arc: string): Provider =>
    closingProviderAmong(arcs.bindings.sessionsBoundTo(arc));
  const arcs = arcService({
    cwd,
    trusted: projectTrusted,
    workspaceSlug,
    memory,
    boundSessionCounts: () => boundSessionCounts(sessionDir),
    flushFor: (sessionId) => sweepFlushFor(options.storeOf(sessionId), agents.flushOf(sessionId)),
    closing: closingSeamFor(closingProviderFor),
    citedNotes: (slug) => citations.citedNotes(slug),
    lastActivity: (slug) => latestArcActivity(sessionDir, slug),
    onReleased: options.onReleased,
  });
  const bots = botMemory({
    cwd,
    projectTrusted,
    workspaceSlug,
    userRoot,
    memory,
    roster: extensions.bots,
    bindingOf: (sessionId) => options.storeOf(sessionId)?.botBinding(),
    skills: extensions.skills,
  });
  await bots.prepare();
  const agents = composeAgents(composition, {
    permissions: options.permissions,
    arcs,
    bots,
    citations,
    thinking: options.thinking,
    notice,
  });
  const sweep: WorkspaceSweep = {
    memory,
    skills: () => workspaceSkillEvidence(composition.skills, { cwd, workspaceSlug, userRoot }),
    bots,
    judgmentFor: botJudgmentFrom(closingProviderAmong, options.liveStores),
  };
  return {
    composition,
    agents,
    arcs,
    bots,
    botNamed: (name) => extensions.bots.find((bot) => bot.name === name),
    attached: async (store) => {
      citations.forSession(store.header.id);
      await arcs.attached(store);
      await host.startSession({ reason: sessionReasonFor(store), store });
    },
    released: async (sessionId) => {
      agents.release(sessionId);
      arcs.released(sessionId);
      citations.release(sessionId);
      await host.endSession("switch", sessionId);
    },
    close: async () => {
      await sweepWorkspaceOnClose(sweep).catch((cause: unknown) => {
        notice(`memory sweep failed: ${toError(cause).message}`);
      });
      await closeExtensionHost(host);
      await composition.languagePort?.dispose();
      await composition.mcp?.stop();
    },
  };
}
