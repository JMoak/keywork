import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Agent,
  type AgentContext,
  type AnsweredAsk,
  acceptedGrantRules,
  type BotDefinition,
  type ChangedPath,
  type Checkpoints,
  type CreatureHost,
  type CreatureMail,
  CreatureProjectError,
  type CreatureSessionTag,
  childDirFor,
  claimSession,
  compactionDue,
  contextMeasureOf,
  creatureMail,
  creatureTagOf,
  decideForKeeper,
  type EffortLevel,
  flushMemoryNow,
  formatReference,
  type GrantRule,
  hostWorkshop,
  type InferenceBinding,
  isEffortLevel,
  isPromptEntry,
  type JournalTap,
  type KeeperOutcome,
  type KeeperTap,
  keeperContextOf,
  knownCostNanos,
  latestSessionTotals,
  type Mailboxes,
  type MemoryStore,
  type Message,
  type MessageEntry,
  type ModelChangeEntry,
  type ModelReference,
  messageText,
  modelReferenceOf,
  type PermissionLedger,
  type PermissionResolver,
  type PersistentShell,
  type ProbeHttp,
  type ProjectWorkRequest,
  type PromptOrigin,
  type Provider,
  ProviderAnswerBook,
  postureResolver,
  type QueuedPrompt,
  type ReviewVerdict,
  readAgentContext,
  readMeasured,
  recordHunkVerdict,
  recordKeeperVerdict,
  rememberFrom,
  restorePointOf,
  type SendBehavior,
  type SendOptions,
  type SessionEntry,
  SessionStore,
  ShellSession,
  type ShowSettings,
  type ShowTarget,
  type ShowThread,
  type StagedItem,
  scopeContains,
  sessionPosture,
  type ThreadOutcome,
  type ToolGuard,
  type ToolPosture,
  type ToolScope,
  type TurnEnding,
  type TurnSettlement,
  tapJournal,
  tapKeeperVerdicts,
  type Usage,
  type VerdictMark,
  type WakeScheduler,
  type WorkspaceSessionRef,
} from "@keywork/engine";
import {
  type AskDecider,
  AskQueue,
  type ByteRange,
  ChangesFeed,
  type ChangesSource,
  type ChangesSummary,
  type CompactionReport,
  type CostReport,
  changesPortOver,
  deskRowOf,
  EventLog,
  type ExportOutcome,
  type ExportScope,
  type FlushReport,
  type ForgetReport,
  issueToken,
  type LeafOutcome,
  listen,
  loggedMessages,
  type ModelSwitch,
  type PresetHost,
  type PresetOutcome,
  type QueueRefusal,
  type QueueReport,
  type RedoReport,
  type RestorePreview,
  type RestoreReport,
  type RestoreScope,
  readServerTicket,
  removeServerTicket,
  type ServerTicket,
  SessionBusyError,
  type SessionDetail,
  type SessionHost,
  type SessionInference,
  type SessionSettlement,
  type SessionState,
  type SessionSummary,
  type SpillRefusal,
  type SpillSlice,
  servedGrants,
  spillReferenceAmong,
  spillSlice,
  type UndoReport,
  type WorkspaceInfo,
  writeServerTicket,
} from "@keywork/server";
import {
  type KeyworkConfig,
  type LspConfig,
  type McpServerConfig,
  type ModelCapabilitiesConfig,
  type PermissionRule,
  type PresetName,
  type PromptsConfig,
  requiresConfirmation,
  resolveAnchor,
  toError,
} from "@keywork/shared";
import type { CreatureSeat } from "./compose.ts";
import type { MemoryDeciderSetup } from "./memory-decider.ts";
import type { HouseMeshConsole } from "./node/compose.ts";
import { defaultSessionDir, keyworkHome, workspaceIdentity } from "./paths.ts";
import { servedCampaigns } from "./serve-campaigns.ts";
import { cataloguedInventory, catalogueFileOf, openRouterCatalogue } from "./serve-catalogue.ts";
import { sessionChanges } from "./serve-changes.ts";
import { requireProjectModel } from "./serve-conversation-model.ts";
import { servedCreatureProjects } from "./serve-creature-projects.ts";
import {
  type CreaturePlace,
  creatureRegistryAt,
  creatureSeats,
  finishThread,
  keptConversation,
  type ServedCreatureSessions,
  type SettledThread,
  servedCreatures,
} from "./serve-creatures.ts";
import { type LifecycleSessions, servedLifecycle, trashSession } from "./serve-lifecycle.ts";
import { servedCreatureMcp } from "./serve-mcp.ts";
import { servedMemory, stagedInbox } from "./serve-memory.ts";
import {
  creatureInitialProvider,
  refreshableModels,
  selectedCreatureProvider,
  unavailableSelectedProvider,
} from "./serve-models.ts";
import { type MeteredTurn, type NodeInventorySeams, servedNode } from "./serve-node.ts";
import { type NeighbourSession, restorePreviewOf, sessionPathsFromTurn } from "./serve-restore.ts";
import {
  creatureDirectoryOver,
  type RoutineSessions,
  type ServedRoutines,
  servedRoutines,
} from "./serve-routines.ts";
import {
  type ServedSettings,
  servedSettings,
  showThreadOf,
  workspaceSettingsFile,
} from "./serve-show.ts";
import { loggedCostNanos, SpendLedger } from "./serve-spend.ts";
import { type ServedSession, surfacePorts } from "./serve-surfaces.ts";
import { servedTree } from "./serve-tree.ts";
import { composeServedWorkspace, type ServedWorkspace } from "./serve-workspace.ts";
import {
  budgetOf,
  compactSessionNow,
  type SessionFlushes,
  type SettlingSession,
  settleSessionTurn,
} from "./session-settle.ts";
import { exportSession } from "./sessions/export.ts";
import { sessionHtml } from "./sessions/export-html.ts";
import { heldGrantsOf, recordHeldGrants } from "./sessions/grants-journal.ts";
import { forkOrigin } from "./sessions/lifecycle.ts";
import { moveLeaf, rewindBefore } from "./sessions/ports.ts";
import {
  type JournaledRestore,
  journalRestore,
  undoRestore,
  unsettledRestoreOf,
} from "./sessions/rewind-journal.ts";
import {
  findSession,
  newSessionFileName,
  type SessionSummary as StoredSummary,
  scanSessions,
  summarize,
} from "./sessions/store.ts";
import { freezeTurn } from "./sessions/turn-journal.ts";
import { excerpt } from "./text.ts";
import { keyworkVersion } from "./version.ts";
import { WorkspaceInUseError, withWorkspaceWriter } from "./workspace-ownership.ts";
import { workspacePermissions } from "./workspace-permissions.ts";

export interface ServeOptions extends HostOptions {
  port?: number | undefined;
  ticketFile?: string | undefined;
  fetch?: typeof fetch | undefined;
  tokenOnStdout?: boolean | undefined;
  reopen?: (() => Promise<HostOptions>) | undefined;
  signal: AbortSignal;
  print: (line: string) => void;
  printError: (line: string) => void;
}

export interface HostOptions {
  cwd: string;
  projectTrusted: boolean;
  managedHome?: boolean | undefined;
  provider: Provider;
  currentProvider?: (() => Provider) | undefined;
  refreshInference?: (() => Promise<void>) | undefined;
  permissions: PermissionResolver;
  inference?: SessionInference | undefined;
  inventory?: NodeInventorySeams | undefined;
  presets?: PresetHost | undefined;
  checkpoints?: "on" | "off" | undefined;
  checkpointsGitDir?: string | undefined;
  askTimeoutMs?: number | undefined;
  openShell?: ((cwd: string) => PersistentShell) | undefined;
  workspaceSlug?: string | undefined;
  sessionDir?: string | undefined;
  userRoot?: string | undefined;
  prompts?: PromptsConfig | undefined;
  mcpServers?: Record<string, McpServerConfig> | undefined;
  repoMap?: "auto" | "off" | undefined;
  lsp?: LspConfig | undefined;
  sandbox?: KeyworkConfig["sandbox"] | undefined;
  models?: ModelCapabilitiesConfig | undefined;
  thinking?: KeyworkConfig["thinking"] | undefined;
  theme?: string | undefined;
  closingProvider?: Provider | undefined;
  memoryDecider?: MemoryDeciderSetup | undefined;
  notice?: ((text: string) => void) | undefined;
  recompose?: (() => Promise<void>) | undefined;
  modelProbe?: ProbeHttp | undefined;
}

export function serverTicketFile(userRoot?: string): string {
  return join(keyworkHome(userRoot), "server.json");
}

export function workspaceTicketFile(cwd: string, slug?: string, userRoot?: string): string {
  return join(keyworkHome(userRoot), "workspaces", workspaceIdentity(cwd, slug), "server.json");
}

export function ticketFilesFor(cwd: string, slug?: string, userRoot?: string): string[] {
  return [workspaceTicketFile(cwd, slug, userRoot), serverTicketFile(userRoot)];
}

export const alreadyServingExit = 2;

export async function serve(options: ServeOptions): Promise<number> {
  try {
    return await withWorkspaceWriter(options, () => serveOwned(options));
  } catch (cause) {
    if (!(cause instanceof WorkspaceInUseError)) throw cause;
    const ticketFile =
      options.ticketFile ??
      workspaceTicketFile(options.cwd, options.workspaceSlug, options.userRoot);
    const running = await runningServerAmong([ticketFile], options.fetch ?? fetch);
    options.printError(
      running === undefined
        ? `keywork serve: ${cause.message}`
        : `keywork serve: a keywork server for this workspace is already listening at ${running.url} · attach to it, or stop it first`,
    );
    return alreadyServingExit;
  }
}

async function serveOwned(options: ServeOptions): Promise<number> {
  const ticketFile =
    options.ticketFile ?? workspaceTicketFile(options.cwd, options.workspaceSlug, options.userRoot);
  const running = await runningServerAmong([ticketFile], options.fetch ?? fetch);
  if (running !== undefined) {
    options.printError(
      `keywork serve: a keywork server for this workspace is already listening at ${running.url} · attach to it, or stop it first`,
    );
    return alreadyServingExit;
  }
  const log = new EventLog();
  const settings = await servedSettings({
    log,
    file: workspaceSettingsFile(options),
    sessionDir: sessionDirOf(options),
    notice: (text) => options.printError(`keywork serve: ${text}`),
  });
  try {
    return await serveListening(options, { log, settings, ticketFile });
  } finally {
    settings.close();
  }
}

interface WorkspaceServing {
  log: EventLog;
  settings: ServedSettings;
  ticketFile: string;
}

async function serveListening(
  options: ServeOptions,
  { log, settings, ticketFile }: WorkspaceServing,
): Promise<number> {
  let server: Awaited<ReturnType<typeof listen>>;
  const hostOf = (hosting: HostOptions, recompose?: () => Promise<void>) =>
    servedHost({ ...hosting, log, settings, notice: options.printError, recompose });
  const host = await hostOf(options, async () => {
    const trusted = { ...((await options.reopen?.()) ?? options), projectTrusted: true };
    await server.rehost(await hostOf(trusted));
  });
  const token = issueToken();
  try {
    server = await listen({
      token,
      host,
      log,
      version: keyworkVersion,
      port: options.port,
      workspace: workspaceInfoOf(options.cwd, options.workspaceSlug),
    });
  } catch (cause) {
    options.printError(`keywork serve: ${cause instanceof Error ? cause.message : String(cause)}`);
    await host.close();
    return 1;
  }
  writeServerTicket(ticketFile, { url: server.url, token });
  options.print(`listening on ${server.url}`);
  if (options.tokenOnStdout !== false) options.print(`token ${token}`);
  options.print(`ticket ${ticketFile}`);
  await untilAborted(options.signal);
  await server.close();
  removeServerTicket(ticketFile);
  return 0;
}

function sessionDirOf(options: Pick<HostOptions, "sessionDir" | "cwd" | "workspaceSlug">): string {
  return options.sessionDir ?? defaultSessionDir(options.cwd, options.workspaceSlug);
}

export function workspaceInfoOf(cwd: string, slug?: string): WorkspaceInfo {
  return { anchor: resolveAnchor(cwd).root, identity: workspaceIdentity(cwd, slug) };
}

export async function runningServerAmong(
  ticketFiles: readonly string[],
  fetcher: typeof fetch,
): Promise<ServerTicket | undefined> {
  for (const file of ticketFiles) {
    const ticket = readServerTicket(file);
    if (ticket === undefined) continue;
    if (await answersAsKeywork(ticket, fetcher)) return ticket;
    removeServerTicket(file);
  }
  return undefined;
}

export async function answersAsKeywork(
  ticket: ServerTicket,
  fetcher: typeof fetch,
): Promise<boolean> {
  try {
    const response = await fetcher(`${ticket.url}/doc`, {
      signal: AbortSignal.timeout(healthCheckTimeoutMs),
    });
    if (!response.ok) return false;
    const document = (await response.json()) as { info?: { title?: unknown } };
    return document.info?.title === "keywork";
  } catch {
    return false;
  }
}

const healthCheckTimeoutMs = 1500;

function inheritedReferenceOf(provider: Provider): ModelReference | undefined {
  return provider.modelId === undefined
    ? undefined
    : { provider: provider.name, model: provider.modelId };
}

export function fileSessionHost(options: HostOptions & { log: EventLog }): SessionHost {
  const gate = servedGate(options);
  return sessionVerbsHost(new LiveSessions(options, gate), gate);
}

export type ServedHostOptions = HostOptions & {
  log: EventLog;
  settings?: ServedSettings | undefined;
};

export async function servedHost(options: ServedHostOptions): Promise<SessionHost> {
  const { log } = options;
  const place: CreaturePlace = {
    cwd: options.cwd,
    projectTrusted: options.projectTrusted,
    managedHome: options.managedHome,
    workspaceSlug: options.workspaceSlug,
    userRoot: options.userRoot ?? homedir(),
  };
  const notice = (text: string) => options.notice?.(`keywork serve: ${text}`);
  const gate = servedGate(options);
  const answers = new ProviderAnswerBook();
  const catalogue = openRouterCatalogue({
    file: catalogueFileOf(place.userRoot),
    fetch: (url, init) => fetch(url, init),
    now: Date.now,
    notice,
  });
  const inventory =
    options.inventory === undefined ? undefined : cataloguedInventory(options.inventory, catalogue);
  const node = await servedNode({
    ...place,
    log,
    notice,
    modelProbe: options.modelProbe,
    inventory:
      inventory === undefined
        ? undefined
        : {
            ...inventory,
            inherit: () => inheritedReferenceOf(options.currentProvider?.() ?? options.provider),
            answers,
          },
  });
  if (options.inventory !== undefined) void catalogue.refresh();
  const workshops = node.workshops.forWorkspace(options.cwd);
  const registry = creatureRegistryAt(
    place,
    async () => (await sessions.composed()).composition.extensions.bots,
  );
  let stagedOf: (() => readonly StagedItem[]) | undefined;
  const sessionDir = sessionDirOf(options);
  const ownsSettings = options.settings === undefined;
  const shown =
    options.settings ??
    (await servedSettings({ log, file: workspaceSettingsFile(place), sessionDir, notice }));
  const localSeat = creatureSeats({
    registry,
    workshops,
    grants: (sessionId) => grantsHeldBy(gate.ledger, sessionId),
    wakes: (): WakeScheduler | undefined => routines?.service,
    payload: async (sessionId) => routines?.service.payloadOf(sessionId),
    mail: () => mail,
    staged: () => stagedOf?.() ?? [],
    notice,
  });
  const modelOptions = {
    registry,
    inference: options.inference,
    policy: node.policy,
    registrations: inventory?.registrations,
    inherit:
      options.inference === undefined
        ? undefined
        : () => inheritedReferenceOf(options.currentProvider?.() ?? options.provider),
    projectWork: (store: SessionStore) => projectThreadTag(store.entries()) !== undefined,
  };
  const sessions = new LiveSessions(options, gate, {
    seatFor: async (store) => projectThreadSeat(store) ?? localSeat(store),
    initialProvider: creatureInitialProvider(modelOptions),
    providerFor: selectedCreatureProvider(modelOptions),
    settings: shown.settings,
    meter: (turn) => {
      node.usage.record(turn);
      answers.answered(turn.provider);
    },
    failed: (provider, error) => answers.failed(provider, error),
    settled: (thread) => {
      shown.settings.rested(thread.id);
      void finishThreadQuietly(thread);
    },
    keeper: (answered) => recordKeeperVerdict(answered, { nodeState: node.state }),
  });
  const unhosted = shown.hostedBy((id) => sessions.liveThreadOf(id));
  const { composition, arcs, bots } = await sessions.composed();
  const campaigns = await servedCampaigns({
    root: join(
      keyworkHome(place.userRoot),
      "campaigns",
      workspaceIdentity(options.cwd, options.workspaceSlug),
    ),
    workspace: options.cwd,
    ownerScope: workspaceIdentity(options.cwd, options.workspaceSlug),
    sessionRoot: sessionDir,
    trusted: () => options.projectTrusted,
    provider: options.provider,
    inference: options.inference,
    skills: composition.extensions.skills,
    permissions: options.permissions,
    guardFor: (sessionId, signal) => {
      signal?.addEventListener("abort", () => gate.asks.closeFor(sessionId), { once: true });
      return gate.asks.guardFor(sessionId, { decide: false });
    },
    closeAsks: (sessionId) => gate.asks.closeFor(sessionId),
    notice,
  });
  stagedOf = stagedInbox(composition.memory);
  const creatures = servedCreatures({
    registry,
    sessions: creatureSessionsOf(sessions, gate, log),
    workshops,
    nextRun: async (slug) => routines?.nextRun(slug),
    spentToday: async (slug, date) => node.usage.spentOn(slug, date),
    notice,
  });
  const trustedMemory = (): MemoryStore | undefined => {
    const workspace = composition.memory();
    return workspace?.store.trusted === true ? workspace.store : undefined;
  };
  const mail =
    node.mesh === undefined ? undefined : servedMail(node.mesh, creatures, trustedMemory);
  const finishThreadQuietly = (thread: SettledThread) =>
    finishThread(creatures, thread).catch((cause: unknown) =>
      notice(`thread ${thread.id.slice(0, 8)} did not report back: ${toError(cause).message}`),
    );
  const verbs = sessionVerbsHost(
    sessions,
    gate,
    keptConversation(creatures.threads, async (slug) => (await registry.read(slug)) !== undefined),
  );
  const routines: ServedRoutines | undefined = options.projectTrusted
    ? await servedRoutines({
        state: node.routines,
        workspace: options.cwd,
        sessions: routineSessionsOf(sessions, verbs, creatures, gate),
        creatures,
        directory: creatureDirectoryOver(registry),
        log,
      })
    : undefined;
  gate.asks.decideWith(
    keeperDecider({
      nodeState: node.state,
      log,
      stored: (id) => sessions.stored(id),
      workshopOf: (id) => sessions.liveOnly(id)?.seat()?.workshop,
    }),
  );
  const surfaces = surfacePorts({
    ...options,
    sessionDir,
    arcs,
    composition: () => Promise.resolve(composition),
    session: (id) => sessions.bound(id),
  });
  const homeWorkspace = {
    ...surfaces.workspace,
    report: async () =>
      ({ ...(await surfaces.workspace.report()), trust: "trusted", readiness: "ready" }) as const,
    trust: async () => ({
      trusted: true as const,
      root: options.cwd,
      vault: join(options.cwd, ".keywork", "memory"),
      reopens: false,
      recomposed: false,
    }),
  };
  return {
    ...verbs,
    ...surfaces,
    ...(options.managedHome && { workspace: homeWorkspace }),
    ...servedCreatureProjects({
      ...place,
      registry,
      start: (request, generation) => sessions.submitProjectRequest(request, generation),
      discuss: async (request, generation) =>
        sessions.submitProjectRequest(
          request,
          generation,
          await creatures.threads.conversationFor(request.creature.slug),
        ),
    }),
    memory: servedMemory({ memory: composition.memory, arcs, bots }),
    creatures,
    ...servedCreatureMcp({ creatures, sessions, mesh: node.mesh }),
    ...(routines !== undefined && { routines: routines.service }),
    models: refreshableModels(node.models, options.refreshInference),
    campaigns,
    workshops,
    ...(node.mesh !== undefined && { mesh: { ...node.mesh, messages: mail } }),
    show: shown.settings,
    close: async () => {
      unhosted();
      if (ownsSettings) shown.close();
      routines?.stop();
      const closingCampaigns = campaigns.close();
      await verbs.close();
      await closingCampaigns;
      await routines?.close();
      await node.usage.flush();
    },
  };
}

interface ServedGate {
  asks: AskQueue;
  ledger: PermissionLedger;
}

function servedGate(options: HostOptions & { log: EventLog }): ServedGate {
  const ledger = workspacePermissions({ ...options, user: options.permissions });
  const asks = new AskQueue({
    grants: servedGrants(ledger, options.log),
    ...(options.askTimeoutMs !== undefined && { timeoutMs: options.askTimeoutMs }),
  });
  return { asks, ledger };
}

function sessionVerbsHost(
  sessions: LiveSessions,
  { asks, ledger }: ServedGate,
  keeps?: LifecycleSessions["keeps"],
): SessionHost {
  const onLive = async <T>(
    id: string,
    act: (live: LiveSession) => T | Promise<T>,
  ): Promise<T | "missing"> => {
    const live = await sessions.open(id);
    return live === undefined ? "missing" : act(live);
  };
  const notQueuedIn = async (id: string): Promise<"missing" | "unknown"> =>
    (await sessions.stored(id)) === undefined ? "missing" : "unknown";
  return {
    list: async () => {
      const pending = asks.list();
      return (await sessions.list()).map((summary) =>
        deskRowOf(summary, {
          asks: pending,
          live: (id) => sessions.liveOnly(id) !== undefined,
          working: (id) => sessions.liveOnly(id)?.busy() === true,
          changes: (id) => sessions.changesOf(id),
        }),
      );
    },
    read: (id) => sessions.read(id),
    create: () => sessions.create(),
    prompt: (id, text, behavior) => onLive(id, (live) => live.run(text, { behavior })),
    inject: (id, text, origin) =>
      onLive(id, (live) =>
        origin.kind === "creature" ? live.frame(text, origin) : live.run(text, { origin }),
      ),
    abort: async (id) => {
      const live = sessions.liveOnly(id);
      if (live !== undefined) return live.interrupt();
      return (await sessions.stored(id)) === undefined ? "missing" : "idle";
    },
    setModel: (id, reference) => onLive(id, (live) => live.switchModel(reference)),
    setThinking: (id, on) => onLive(id, (live) => live.setThinking(on)),
    setEffort: (id, level) => onLive(id, (live) => live.setEffort(level)),
    compact: (id, focus) => onLive(id, (live) => live.compact(focus)),
    undo: (id) => onLive(id, (live) => live.undo()),
    redo: (id) => onLive(id, (live) => live.redo()),
    restore: (id, turn, scope) => onLive(id, (live) => live.restore(turn, scope)),
    previewRestore: (id, turn, scope) => sessions.previewRestore(id, turn, scope),
    context: (id) => onLive(id, (live) => live.context()),
    cost: (id) => onLive(id, (live) => live.cost()),
    exportHtml: (id, scope, out) => onLive(id, (live) => live.exportHtml(scope, out)),
    rename: (id, title) => onLive(id, (live) => live.rename(title)),
    setQuiet: (id, on) => onLive(id, (live) => live.setQuiet(on)),
    flush: (id) => onLive(id, (live) => live.flush()),
    forget: (id, entryId, replacement) => onLive(id, (live) => live.forget(entryId, replacement)),
    spill: (id, spillId, range) => sessions.spill(id, spillId, range),
    queue: {
      setAside: (id) => onLive(id, (live) => live.setQueueAside()),
      move: async (id, itemId, to) =>
        sessions.liveOnly(id)?.moveQueued(itemId, to) ?? notQueuedIn(id),
      cancel: async (id, itemId) => sessions.liveOnly(id)?.cancelQueued(itemId) ?? notQueuedIn(id),
    },
    applyPreset: (name, confirmed) => sessions.applyPreset(name, confirmed),
    tree: servedTree({
      sessionDir: sessions.sessionDir,
      bound: (id) => sessions.bound(id),
      moveLeaf: (id, entryId) => onLive(id, (live) => live.moveLeaf(entryId)),
    }),
    changes: {
      ...changesPortOver({ has: async (id) => (await sessions.bound(id)) !== undefined }, (id) =>
        sessions.changesSource(id),
      ),
      verdict: (id, verdict) => onLive(id, (live) => live.verdict(verdict)),
    },
    lifecycle: servedLifecycle({ ...lifecycleOf(sessions), keeps }),
    asks: async () => asks.list(),
    answerAsk: async (callId, verdict, scope, denial) =>
      asks.answer(callId, verdict, scope, denial),
    permissions: async () => ({ ...ledger.view(), quiet: ledger.quietSessions() }),
    grantWorkspaceRule: async (rule) => ledger.record("", "workspace", [rule]),
    grantSessionRule: async (sessionId, rule) => {
      if ((await sessions.open(sessionId)) === undefined) return false;
      ledger.record(sessionId, "session", [rule]);
      return true;
    },
    revokeWorkspaceGrant: async (rule) => ledger.revokeWorkspace(rule),
    revokeSessionGrant: async (sessionId, rule) =>
      (await sessions.open(sessionId)) !== undefined && ledger.revokeSession(sessionId, rule),
    close: async () => {
      asks.close();
      await sessions.close();
    },
  };
}

interface SessionRuntime {
  log: EventLog;
  cwd: string;
  scope: ToolScope;
  checkpoints: Checkpoints | undefined;
  changes: ChangesFeed;
  ledger: PermissionLedger;
  inference: SessionInference | undefined;
  fallback: Provider;
  initialProvider(): Promise<Provider>;
  flushes: SessionFlushes;
  turn: TurnCheckpoint;
  notice(text: string): void;
  forge(provider: Provider, history: readonly Message[]): Agent;
  botNamed(name: string | undefined): BotDefinition | undefined;
  seat(): CreatureSeat | undefined;
  reseat(): Promise<void>;
  meter(usage: Usage, provider: Provider): void;
  failed(error: Error, provider: Provider): void;
  settled(outcome: ThreadOutcome, lastReply: string): void;
  keeper: ((answered: AnsweredAsk) => Promise<KeeperOutcome>) | undefined;
}

type CreatureSeams = Pick<
  SessionRuntime,
  "seat" | "reseat" | "meter" | "failed" | "settled" | "keeper"
>;

interface SessionSeams {
  seatFor?(store: SessionStore): Promise<CreatureSeat | undefined>;
  initialProvider?(store: SessionStore): Promise<Provider | undefined>;
  providerFor?(store: SessionStore, binding: InferenceBinding): Provider;
  meter?(turn: MeteredTurn): void;
  failed?(provider: string, error: Error): void;
  settled?(thread: SettledThread): void;
  keeper?(answered: AnsweredAsk): Promise<KeeperOutcome>;
  settings?: ShowSettings | undefined;
}

const projectThreadType = "keywork.creature-project";

interface ProjectThreadTag {
  key: string;
  creature: ProjectWorkRequest["creature"];
}

function projectThreadTag(entries: readonly SessionEntry[]): ProjectThreadTag | undefined {
  for (const entry of entries) {
    if (
      entry.type !== "custom" ||
      entry.customType !== projectThreadType ||
      typeof entry.data !== "object" ||
      entry.data === null
    )
      continue;
    const candidate = entry.data as Partial<ProjectThreadTag>;
    if (
      typeof candidate.key === "string" &&
      typeof candidate.creature?.workspace === "string" &&
      typeof candidate.creature.slug === "string"
    )
      return { key: candidate.key, creature: candidate.creature };
  }
  return undefined;
}

function projectThreadSeat(store: SessionStore): CreatureSeat | undefined {
  const tag = projectThreadTag(store.entries());
  if (tag === undefined) return undefined;
  return {
    workshop: hostWorkshop,
    injection: () =>
      `This is a project thread for creature "${tag.creature.slug}". Work in the project's authorized tool scope.`,
  };
}

class LiveSessions {
  readonly sessionDir: string;
  private readonly live = new Map<string, LiveSession>();
  private readonly runningChildren = new Map<string, RunningChild>();
  private readonly opening = new Map<string, Promise<LiveSession>>();
  private readonly projectRequests = new Map<string, Promise<WorkspaceSessionRef>>();
  private readonly changes: ChangesFeed;
  private readonly frozenChanges = new Map<string, ChangesSummary>();
  private readonly confinements = new Map<string, ToolPosture>();
  private readonly unjournalGrants: () => void;
  private workspace: Promise<ServedWorkspace> | undefined;

  constructor(
    private readonly options: HostOptions & { log: EventLog },
    private readonly gate: ServedGate,
    private readonly seams: SessionSeams = {},
  ) {
    this.sessionDir = sessionDirOf(options);
    this.changes = new ChangesFeed(options.log, (id) => this.changesSource(id));
    this.unjournalGrants = gate.ledger.onSessionRules((id, rules) =>
      this.live.get(id)?.journalGrants(rules),
    );
  }

  async list(): Promise<SessionSummary[]> {
    const { stores } = await scanSessions(this.sessionDir);
    const summarized = await Promise.all(stores.map((store) => this.summaryOf(store)));
    const listed = summarized
      .sort((a, b) => b.stored.modifiedAt.getTime() - a.stored.modifiedAt.getTime())
      .map(({ summary }) => summary);
    const unlisted = [...this.live.values()]
      .filter((live) => !listed.some((summary) => summary.id === live.id))
      .map((live) => live.summary());
    return [...unlisted, ...listed];
  }

  async read(id: string): Promise<SessionDetail | undefined> {
    const live = this.liveOnly(id);
    if (live !== undefined) return this.withForkOrigin(live.detail(this.options.log.latestId()));
    const child = this.runningChildren.get(id);
    const store = child?.store ?? (await this.stored(id));
    if (store === undefined) return undefined;
    const messages = child?.agent.history() ?? store.messages();
    return this.withForkOrigin({
      ...this.pricedSummary(await summarize(store), store),
      messageCount: messages.length,
      cwd: store.header.cwd,
      live: child !== undefined,
      messages,
      ...store.messageMarks(child?.agent.busy() === true),
      asOf: this.options.log.latestId(),
      ...parentSessionOf(store),
    });
  }

  changesOf(id: string): ChangesSummary | undefined {
    return this.changes.lastAnnounced(id) ?? this.frozenChanges.get(id);
  }

  async previewRestore(
    id: string,
    turn: number,
    scope: RestoreScope,
  ): Promise<RestorePreview | "missing" | "unknown-turn"> {
    const session = await this.bound(id);
    if (session === undefined) return "missing";
    const { checkpoints } = (await this.composed()).composition;
    return restorePreviewOf(checkpoints, session, { turn, scope }, () => this.neighboursOf(id));
  }

  async spill(id: string, spillId: string, range: ByteRange): Promise<SpillSlice | SpillRefusal> {
    const bound = await this.bound(id);
    if (bound === undefined) return "missing";
    const unsaved = this.liveOnly(id)?.history() ?? [];
    const logged = loggedMessages(bound.store.entries());
    const reference = spillReferenceAmong([...logged, ...unsaved], spillId);
    if (reference === undefined) return "unknown-spill";
    return spillSlice(bound.store.spills(), reference, range);
  }

  async release(id: string): Promise<void> {
    const live = this.live.get(id);
    if (live === undefined) return;
    this.live.delete(id);
    await live.close();
    await (await this.composed()).released(id);
  }

  private async withForkOrigin(detail: SessionDetail): Promise<SessionDetail> {
    const forkedFrom = await forkOrigin(this.sessionDir, detail.parentSession);
    return forkedFrom === undefined ? detail : { ...detail, forkedFrom };
  }

  async create(): Promise<SessionSummary> {
    return (await this.adopt(await this.newStore())).summary();
  }

  async openClaimed(tag: CreatureSessionTag): Promise<string> {
    const store = await this.newStore();
    await claimSession(store, tag);
    return (await this.adopt(store)).id;
  }

  submitProjectRequest(
    request: ProjectWorkRequest,
    generation: string,
    conversation?: string,
  ): Promise<WorkspaceSessionRef> {
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          request.creature.workspace,
          request.creature.slug,
          generation,
          request.project,
          request.requestId,
          conversation === undefined ? "thread" : "discussion",
        ]),
      )
      .digest("hex");
    const existing = this.projectRequests.get(key);
    if (existing !== undefined) return existing;
    const starting = this.submitProjectPrompt(request, key, conversation).finally(() =>
      this.projectRequests.delete(key),
    );
    this.projectRequests.set(key, starting);
    return starting;
  }

  private async submitProjectPrompt(
    request: ProjectWorkRequest,
    key: string,
    conversation: string | undefined,
  ): Promise<WorkspaceSessionRef> {
    const live =
      conversation === undefined
        ? await this.projectThread(request, key)
        : await this.open(conversation);
    if (live === undefined) throw new CreatureProjectError("missing-session");
    await live.submitOnce(request.text, key);
    return {
      workspace: workspaceIdentity(this.options.cwd, this.options.workspaceSlug),
      session: live.id,
    };
  }

  private async projectThread(request: ProjectWorkRequest, key: string): Promise<LiveSession> {
    const existing = (await scanSessions(this.sessionDir)).stores.find(
      (store) => projectThreadTag(store.entries())?.key === key,
    );
    if (existing !== undefined) return this.adopt(existing);
    const store = await this.newStore();
    await store.appendCustom(projectThreadType, {
      key,
      creature: request.creature,
      project: request.project,
      source: request.source,
    });
    return this.adopt(store);
  }

  confine(id: string, posture: ToolPosture, grants: readonly GrantRule[]): void {
    this.confinements.set(id, posture);
    if (grants.length > 0) this.gate.ledger.record(id, "session", acceptedGrantRules(grants));
  }

  async open(id: string): Promise<LiveSession | undefined> {
    const live = this.liveOnly(id);
    if (live !== undefined) return live;
    if (this.runningChildren.has(id)) return undefined;
    const store = await this.stored(id);
    return store === undefined ? undefined : this.adopt(store);
  }

  liveOnly(id: string): LiveSession | undefined {
    return this.live.get(id);
  }

  stored(id: string): Promise<SessionStore | undefined> {
    return findSession(this.sessionDir, id);
  }

  liveThreadOf(id: string): ShowThread | undefined {
    const live = this.liveOnly(id)?.served().store;
    return live === undefined ? undefined : showThreadOf(live);
  }

  async changesSource(id: string): Promise<ChangesSource | undefined> {
    const { composition } = await this.composed();
    const session = await this.bound(id);
    if (composition.checkpoints === undefined || session === undefined) return undefined;
    return sessionChanges(composition.checkpoints, composition.scope, session);
  }

  async bound(id: string): Promise<ServedSession | undefined> {
    const live = this.liveOnly(id);
    if (live !== undefined) return live.served();
    const child = this.runningChildren.get(id);
    if (child !== undefined) return { store: child.store, busy: () => true };
    const store = await this.stored(id);
    return store === undefined ? undefined : { store, busy: () => false };
  }

  async applyPreset(name: PresetName, confirmed: boolean): Promise<PresetOutcome> {
    const presets = this.options.presets;
    if (presets === undefined) return "unavailable";
    const from = presets.active();
    if (from === name) return { from, to: name };
    if (requiresConfirmation(from, name) && !confirmed) return "needs-confirmation";
    await presets.apply(name);
    for (const live of this.live.values()) live.announcePreset(from, name);
    return { from, to: name };
  }

  async close(): Promise<void> {
    this.unjournalGrants();
    for (const childId of [...this.runningChildren.keys()]) this.childReleased(childId);
    for (const live of this.live.values()) await live.close();
    await this.changes.settled();
    if (this.workspace !== undefined) await (await this.workspace).close();
    this.live.clear();
  }

  private async summaryOf(
    store: SessionStore,
  ): Promise<{ stored: StoredSummary; summary: SessionSummary }> {
    const stored = await summarize(store);
    const summary = this.liveOnly(store.header.id)?.summary() ?? this.pricedSummary(stored, store);
    this.freezeChanges(store);
    return { stored, summary };
  }

  private freezeChanges(store: SessionStore): void {
    const totals = latestSessionTotals(store.activePath());
    if (totals === undefined) this.frozenChanges.delete(store.header.id);
    else this.frozenChanges.set(store.header.id, totals);
  }

  private async neighboursOf(id: string): Promise<NeighbourSession[]> {
    const { stores } = await scanSessions(this.sessionDir);
    const others = stores.filter((store) => store.header.id !== id);
    return Promise.all(
      others.map(async (store) => ({
        id: store.header.id,
        title: (await summarize(store)).title,
        ...(this.liveOnly(store.header.id)?.served() ?? { store }),
      })),
    );
  }

  private pricedSummary(stored: StoredSummary, store: SessionStore): SessionSummary {
    const costNanos = loggedCostNanos(store.entries(), this.options.provider);
    return { ...storedSummary(stored, store), ...(costNanos !== undefined && { costNanos }) };
  }

  private adopt(store: SessionStore): Promise<LiveSession> {
    const id = store.header.id;
    const live = this.live.get(id);
    if (live !== undefined) return Promise.resolve(live);
    const opening = this.opening.get(id);
    if (opening !== undefined) return opening;
    const pending = this.adoptNew(store).finally(() => this.opening.delete(id));
    this.opening.set(id, pending);
    return pending;
  }

  private async adoptNew(store: SessionStore): Promise<LiveSession> {
    const workspace = await this.composed();
    const { composition, agents } = workspace;
    const { options } = this;
    const id = store.header.id;
    const shell = options.openShell?.(options.cwd) ?? new ShellSession(options.cwd);
    const turn = new TurnCheckpoint();
    const guard = checkpointingGuard(this.gate.asks.guardFor(id), composition.checkpoints, turn);
    const permissions = this.confinedResolver(store);
    const creature = await this.creatureSeams(store);
    const inference = options.inference;
    const runtime: SessionRuntime = {
      log: options.log,
      cwd: composition.scope.cwd,
      scope: composition.scope,
      checkpoints: composition.checkpoints,
      changes: this.changes,
      ledger: this.gate.ledger,
      inference:
        inference === undefined
          ? undefined
          : {
              bind: (reference) => inference.bind(reference),
              provider: (binding) =>
                this.seams.providerFor?.(store, binding) ?? inference.provider(binding),
            },
      fallback: options.provider,
      initialProvider: async () =>
        (await this.seams.initialProvider?.(store)) ??
        options.currentProvider?.() ??
        options.provider,
      flushes: agents,
      turn,
      notice: (text) => options.notice?.(`keywork serve: ${text}`),
      forge: (provider, history) =>
        agents.build({
          provider,
          guard,
          shell,
          history,
          sessionId: id,
          spills: store.spills(),
          permissions,
          bot: workspace.botNamed(store.botBinding()),
          creature: creature.seat(),
          show: this.showTargetOf(store),
        }),
      botNamed: workspace.botNamed,
      ...creature,
    };
    const live = new LiveSession(store, shell, runtime);
    this.live.set(id, live);
    await workspace.attached(store);
    return live;
  }

  private showTargetOf(store: SessionStore): ShowTarget | undefined {
    const { settings } = this.seams;
    if (settings === undefined) return undefined;
    return {
      creature: creatureTagOf(store.entries())?.creature ?? null,
      sessionId: store.header.id,
      settings: () => settings,
    };
  }

  private confinedResolver(store: SessionStore): PermissionResolver {
    const id = store.header.id;
    return postureResolver(
      () => sessionPosture(creatureTagOf(store.entries())?.kind, this.confinements.get(id)),
      this.gate.ledger.resolverFor(id),
    );
  }

  private async creatureSeams(store: SessionStore): Promise<CreatureSeams> {
    const { seatFor, meter, failed, settled, keeper } = this.seams;
    const id = store.header.id;
    let seat = await seatFor?.(store);
    return {
      seat: () => seat,
      reseat: async () => {
        seat = await seatFor?.(store);
      },
      meter: (usage, provider) =>
        meter?.({
          usage,
          provider: provider.name,
          model: provider.modelId,
          creature: creatureTagOf(store.entries())?.creature ?? null,
          session: id,
        }),
      failed: (error, provider) => failed?.(provider.name, error),
      settled: (outcome, lastReply) => settled?.({ id, store, outcome, lastReply }),
      keeper,
    };
  }

  composed(): Promise<ServedWorkspace> {
    this.workspace ??= this.compose();
    return this.workspace;
  }

  private newStore(): Promise<SessionStore> {
    return SessionStore.create(join(this.sessionDir, newSessionFileName()), this.options.cwd);
  }

  private compose(): Promise<ServedWorkspace> {
    const { options } = this;
    return composeServedWorkspace({
      cwd: options.cwd,
      projectTrusted: options.projectTrusted,
      workspaceSlug: options.workspaceSlug,
      sessionDir: this.sessionDir,
      userRoot: options.userRoot ?? homedir(),
      provider: options.provider,
      closingProvider: options.closingProvider,
      permissions: options.permissions,
      thinking: options.thinking === "on",
      prompts: options.prompts,
      mcpServers: options.mcpServers,
      repoMap: options.repoMap,
      models: options.models,
      lsp: options.lsp,
      sandbox: options.sandbox,
      memoryDecider: options.memoryDecider,
      checkpoints: options.checkpoints ?? "on",
      checkpointsGitDir: options.checkpointsGitDir,
      notice: (text) => options.notice?.(`keywork serve: ${text}`),
      storeOf: (id) => this.live.get(id)?.served().store,
      liveStores: () => [...this.live.values()].map((live) => live.served().store),
      onReleased: (id) => void this.live.get(id)?.adoptBinding(),
      onChildAttached: (child, agent) => this.childAttached(child, agent),
      onChildReleased: (childId) => this.childReleased(childId),
    });
  }

  private childAttached(store: SessionStore, agent: Agent): void {
    const id = store.header.id;
    const stopRelaying = this.options.log.attach(agent.bus, id);
    this.runningChildren.set(id, { store, agent, stopRelaying });
  }

  private childReleased(childId: string): void {
    this.runningChildren.get(childId)?.stopRelaying();
    this.runningChildren.delete(childId);
  }
}

interface RunningChild {
  store: SessionStore;
  agent: Agent;
  stopRelaying: () => void;
}

interface BoundAgent {
  agent: Agent;
  bot: string | undefined;
  journal: JournalTap;
  keeper: KeeperTap | undefined;
  detach: () => void;
}

interface StagedUndo {
  cancel(): Promise<void>;
}

interface StagedFiles {
  note: string;
  restoredTo: string | undefined;
  redoTree: string | undefined;
  paths: readonly string[] | undefined;
  restore(): Promise<unknown>;
  changed(): Promise<readonly ChangedPath[]>;
}

interface Rewound {
  files: StagedFiles;
  leafId: string;
}

const untouchedFiles: StagedFiles = {
  note: "files untouched",
  restoredTo: undefined,
  redoTree: undefined,
  paths: undefined,
  restore: async () => {},
  changed: async () => [],
};

interface PromptSubmission {
  id: string;
  accept(): void;
}

class LiveSession {
  readonly id: string;
  private bound: BoundAgent;
  private persisted: number;
  private settled: Promise<void> = Promise.resolve();
  private grantsJournaled: Promise<void> = Promise.resolve();
  private staged: StagedUndo | undefined;
  private turnPrompt: MessageEntry | undefined;
  private turnOutcome: ThreadOutcome = "completed";
  private turnFailure: string | undefined;
  private closing = false;
  private readonly spend: SpendLedger;
  private readonly submissions = new Map<string, PromptSubmission>();
  private readonly finishedUsage: Usage[] = [];
  private preparing: Promise<void> | undefined;

  constructor(
    private readonly store: SessionStore,
    private readonly shell: PersistentShell,
    private readonly runtime: SessionRuntime,
  ) {
    this.id = store.header.id;
    this.spend = SpendLedger.fromLog(store.entries(), runtime.fallback);
    this.bound = this.bind(runtime.forge(this.storedProvider(), store.messages()));
    this.adoptStoredSettings();
    this.persisted = this.agent.history().length;
    this.staged = this.reopenedRestore();
  }

  private get agent(): Agent {
    return this.bound.agent;
  }

  async run(
    text: string,
    options: { behavior?: SendBehavior | undefined; origin?: PromptOrigin | undefined },
  ): Promise<"started" | "queued"> {
    await this.prepareProvider();
    const outcome = this.agent.busy() ? "queued" : "started";
    this.staged = undefined;
    const turn = this.agent.send(text, sendOptionsOf(options)).then(
      () => undefined,
      () => undefined,
    );
    this.settled = this.settled.then(() => turn);
    this.announce();
    return outcome;
  }

  async submitOnce(text: string, id: string): Promise<void> {
    const prior = this.store
      .entries()
      .find((entry): entry is MessageEntry => isPromptEntry(entry) && entry.submissionId === id);
    if (prior !== undefined) {
      return messageText(prior.message) === text
        ? Promise.resolve()
        : Promise.reject(new CreatureProjectError("request-conflict"));
    }
    await this.prepareProvider();
    requireProjectModel(this.agent.provider);
    const client = `creature-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      this.submissions.set(client, { id, accept: resolve });
      this.staged = undefined;
      const turn = this.agent
        .send(text, { origin: { kind: "external", client } })
        .then(() => reject(new CreatureProjectError("unavailable")), reject)
        .finally(() => this.submissions.delete(client));
      this.settled = this.settled.then(() => turn).then(() => undefined);
      this.announce();
    });
  }

  async note(text: string, origin: PromptOrigin): Promise<"noted"> {
    await this.report(text, origin);
    this.announce();
    return "noted";
  }

  verdict(verdict: ReviewVerdict): Promise<VerdictMark> {
    return recordHunkVerdict(this.store, this.agent.bus, verdict);
  }

  seat(): CreatureSeat | undefined {
    return this.runtime.seat();
  }

  async frame(text: string, origin: CreatureOrigin): Promise<"started" | "queued"> {
    await this.prepareProvider();
    await this.report(text, origin, "frame");
    if (this.store.name() === undefined) await this.store.setName(origin.creature);
    const outcome = this.agent.busy() ? "queued" : "started";
    this.staged = undefined;
    const turn = this.agent.send(text, sendOptionsOf({ origin })).then(
      (reply) => this.titleFromFirstReply(reply, origin.creature),
      () => undefined,
    );
    this.settled = this.settled.then(() => turn);
    this.announce();
    return outcome;
  }

  private async report(text: string, origin: PromptOrigin, kind?: "frame"): Promise<void> {
    const entry = await this.store.appendCreatureReport(text, origin, kind);
    this.agent.bus.emit("extension.notice", {
      extension: "creature",
      level: "info",
      message: text,
      detail: { origin, entryId: entry.id, ...(kind !== undefined && { kind }) },
    });
  }

  private async titleFromFirstReply(reply: Message, provisional: string): Promise<void> {
    const said = messageText(reply).trim();
    if (said === "" || this.store.name() !== provisional || this.store.titlePinned()) return;
    await this.store.setName(excerpt(said, firstReplyTitleLength));
    this.announce();
  }

  interrupt(): "aborted" | "idle" {
    if (!this.agent.busy()) return "idle";
    this.agent.interrupt();
    return "aborted";
  }

  busy(): boolean {
    return this.agent.busy();
  }

  history(): readonly Message[] {
    return this.agent.history();
  }

  setQueueAside(): readonly QueuedPrompt[] {
    return this.agent.clearQueue();
  }

  moveQueued(itemId: string, to: number): QueueReport | Exclude<QueueRefusal, "missing"> {
    const moved = this.agent.moveQueued(itemId, to);
    return moved === "moved" ? { queued: this.agent.queued() } : moved;
  }

  cancelQueued(itemId: string): QueueReport | "unknown" {
    return this.agent.cancelQueued(itemId) ? { queued: this.agent.queued() } : "unknown";
  }

  async switchModel(reference: string): Promise<ModelSwitch | "busy"> {
    await this.preparing;
    const { inference } = this.runtime;
    if (inference === undefined) {
      return { failure: { code: "unconfigured", message: noRegistry, available: [] } };
    }
    const bound = inference.bind(reference);
    if (!bound.ok) return { failure: bound.failure };
    const provider = inference.provider(bound.binding);
    if (!(await this.idle())) return "busy";
    const model = bound.binding.reference;
    await this.swap(this.runtime.forge(provider, this.agent.history()));
    if (!sameSelection(this.store.modelSelection(), model)) {
      await this.store.appendModelChange(model.provider, model.model);
    }
    this.announce();
    return { model, notice: `model → ${formatReference(model)}` };
  }

  async setThinking(on: boolean): Promise<{ thinking: boolean }> {
    this.agent.setThinking(on);
    const level = on ? "on" : "off";
    if (this.store.thinkingLevel() !== level) await this.store.appendThinkingLevelChange(level);
    this.announce();
    return { thinking: on };
  }

  async setEffort(level: EffortLevel | null): Promise<{ effort: EffortLevel | null } | "busy"> {
    if (level === null) {
      if (!(await this.idle())) return "busy";
      await this.swap(this.runtime.forge(this.agent.provider, this.agent.history()), null);
      const recorded = this.store.effort();
      if (recorded !== undefined && isEffortLevel(recorded)) {
        await this.store.appendEffortChange(providerDefaultEffort);
      }
    } else {
      this.agent.setEffort(level);
      if (this.store.effort() !== level) await this.store.appendEffortChange(level);
    }
    this.announce();
    return { effort: level };
  }

  async compact(focus?: string): Promise<CompactionReport | "busy"> {
    if (!(await this.idle())) return "busy";
    const settlement = await compactSessionNow(this.settling(), focus, this.runtime.flushes);
    this.reportSettlement("requested", settlement);
    if (settlement.history !== undefined) {
      await this.swap(this.runtime.forge(this.agent.provider, settlement.history));
    }
    this.announce();
    return { compacted: settlement.compacted ?? null, notices: settlement.notices };
  }

  async undo(): Promise<UndoReport | "busy" | "nothing"> {
    if (!(await this.idle())) return "busy";
    this.staged = undefined;
    const prompts = this.store.activePath().filter(isPromptEntry);
    const prompt = prompts.at(-1);
    if (prompt === undefined) return this.undoFilesOnly();
    const rewound = await this.stageRewind(prompt, await this.pathsGoingBack(prompts.length));
    if (rewound === undefined) return "nothing";
    this.announce();
    return {
      prompt: { entryId: prompt.id, text: textOf(prompt.message) },
      filesNote: rewound.files.note,
      ...this.travel(),
    };
  }

  async redo(): Promise<RedoReport | "busy" | "nothing"> {
    if (!(await this.idle())) return "busy";
    const staged = this.staged;
    if (staged !== undefined) {
      this.staged = undefined;
      await staged.cancel();
    } else if (!(await this.redoFilesOnly())) {
      return "nothing";
    }
    this.announce();
    return { restored: true, ...this.travel() };
  }

  async restore(
    turn: number,
    scope: RestoreScope,
  ): Promise<RestoreReport | "busy" | "unknown-turn"> {
    if (!(await this.idle())) return "busy";
    const point = restorePointOf(this.store.activePath(), turn);
    if (point === undefined) return "unknown-turn";
    this.staged = undefined;
    const paths = scope === "everything" ? undefined : await this.pathsGoingBack(turn);
    const rewound = await this.stageRewind(point.prompt, paths, turn);
    if (rewound === undefined) return "unknown-turn";
    this.announce();
    return {
      turn,
      prompt: { entryId: point.prompt.id, text: textOf(point.prompt.message) },
      leafId: rewound.leafId,
      undoneTurns: point.undoneTurns,
      scope,
      files: await rewound.files.changed(),
      filesNote: rewound.files.note,
      ...this.travel(),
    };
  }

  context(): AgentContext {
    return readAgentContext(this.agent, budgetOf(this.agent));
  }

  cost(): CostReport {
    return this.spend.report(this.agent);
  }

  costNanos(): number | undefined {
    return knownCostNanos(this.cost().rollup);
  }

  async exportHtml(scope: ExportScope, out?: string): Promise<ExportOutcome> {
    await this.settled;
    if (out === undefined) return { html: sessionHtml(this.store, scope) };
    if (!scopeContains(this.runtime.scope, out)) return "outside-scope";
    return { file: await exportSession(this.store, { scope, out, cwd: this.runtime.cwd }) };
  }

  async moveLeaf(entryId: string | null): Promise<LeafOutcome | "busy" | "unknown-entry"> {
    if (entryId !== null && this.store.entry(entryId) === undefined) return "unknown-entry";
    if (!(await this.idle())) return "busy";
    this.staged = undefined;
    moveLeaf(this.store, entryId);
    await this.swap(this.runtime.forge(this.agent.provider, this.store.messages()));
    this.announce();
    return { leafId: this.store.leafId() };
  }

  async rename(title: string): Promise<{ title: string }> {
    await this.store.setName(title, true);
    this.announce();
    return { title };
  }

  async setQuiet(on: boolean): Promise<{ quiet: boolean }> {
    if (this.store.quiet() !== on) await this.store.appendQuietChange(on);
    this.runtime.ledger.setQuiet(this.id, on);
    this.announce();
    return { quiet: on };
  }

  async flush(): Promise<FlushReport | "busy"> {
    if (!(await this.idle())) return "busy";
    const { agent } = this;
    const settlement = await flushMemoryNow({
      store: this.store,
      history: agent.history(),
      flush: this.runtime.flushes.flushFor(this.id, agent.provider),
    });
    this.reportSettlement("requested", settlement);
    if (settlement.history !== undefined) {
      await this.swap(this.runtime.forge(agent.provider, settlement.history));
    }
    this.announce();
    return { flushed: settlement.flushed.length, notices: settlement.notices };
  }

  async forget(
    entryId: string,
    replacement: string | undefined,
  ): Promise<ForgetReport | "busy" | "unknown-entry"> {
    if (!(await this.idle())) return "busy";
    const target = this.store.activePath().find((entry) => entry.id === entryId);
    if (target === undefined || !isForgettable(target)) return "unknown-entry";
    this.staged = undefined;
    const edit = await this.store.appendContextEdit(entryId, replacement ?? null);
    await this.swap(this.runtime.forge(this.agent.provider, this.store.messages()));
    this.announce();
    return { edit };
  }

  announcePreset(from: string, to: string): void {
    this.agent.bus.emit("gate.preset", { from, to });
  }

  summary(): SessionSummary {
    const stats = this.store.stats();
    const { model, thinking, effort } = this.state();
    const costNanos = knownCostNanos(this.cost().rollup);
    return {
      id: this.id,
      title: this.title(),
      createdAt: this.store.header.timestamp,
      lastActivityAt: stats.lastActivityAt,
      messageCount: this.agent.history().length,
      ...(costNanos !== undefined && { costNanos }),
      ...this.store.binding(),
      ...(model !== undefined && { model }),
      thinking,
      ...(effort !== undefined && { effort }),
    };
  }

  detail(asOf: number): SessionDetail {
    return {
      ...this.summary(),
      cwd: this.store.header.cwd,
      live: true,
      messages: this.agent.history(),
      ...this.store.messageMarks(this.agent.busy()),
      asOf,
      ...parentSessionOf(this.store),
    };
  }

  state(): SessionState {
    const model = this.modelReference();
    const effort = this.agent.effort();
    return {
      ...(model !== undefined && { model }),
      thinking: this.agent.thinking(),
      ...(effort !== undefined && { effort }),
      title: this.title(),
      leafId: this.store.leafId(),
      ...this.store.binding(),
      quiet: this.runtime.ledger.isQuiet(this.id),
      ...this.travel(),
    };
  }

  async close(): Promise<void> {
    this.closing = true;
    this.agent.interrupt();
    await this.settled;
    await this.grantsJournaled;
    await this.release(this.bound);
    await this.shell.close();
  }

  journalGrants(rules: readonly PermissionRule[]): void {
    this.grantsJournaled = this.grantsJournaled
      .then(() => recordHeldGrants(this.store, rules))
      .catch((cause: unknown) =>
        this.runtime.notice(
          `session ${this.id.slice(0, 8)} grants not saved · ${toError(cause).message}`,
        ),
      );
  }

  served(): ServedSession {
    return {
      store: this.store,
      busy: () => this.agent.busy(),
      adoptBinding: () => this.adoptBinding(),
      openCheckpoint: () => this.runtime.turn.current(),
    };
  }

  async adoptBinding(): Promise<void> {
    const bot = this.store.botBinding();
    if (bot !== this.bound.bot) {
      if (!(await this.idle())) throw new SessionBusyError();
      await this.runtime.reseat();
      const provider = await this.providerSeededBy(this.runtime.botNamed(bot));
      await this.swap(this.runtime.forge(provider, this.agent.history()));
    }
    this.announce();
  }

  private title(): string {
    return this.store.name() ?? "(untitled session)";
  }

  private modelReference(): string | undefined {
    const live = modelReferenceOf(this.agent.provider);
    if (live !== undefined) return live;
    const selection = this.store.modelSelection();
    return selection === undefined ? undefined : referenceOf(selection);
  }

  private travel(): { undoable: boolean; redoable: boolean } {
    const { checkpoints } = this.runtime;
    return {
      undoable: lastPromptOnPath(this.store) !== undefined || checkpoints?.canUndo() === true,
      redoable: this.staged !== undefined || checkpoints?.canRedo() === true,
    };
  }

  private announce(): void {
    this.runtime.log.record(this.id, "session.state", this.state());
  }

  private async idle(): Promise<boolean> {
    if (this.agent.busy()) return false;
    await this.settled;
    await this.grantsJournaled;
    return true;
  }

  private async openTurn(agent: Agent): Promise<string | undefined> {
    const origin = agent.turnOrigin();
    const submission =
      origin?.kind === "external" ? this.submissions.get(origin.client) : undefined;
    const written = await this.persistTurn(agent.history(), submission?.id);
    this.turnPrompt = written.findLast(isPromptEntry);
    if (this.turnPrompt?.submissionId === submission?.id) submission?.accept();
    return this.turnPrompt?.id;
  }

  private async afterTurn(): Promise<void> {
    await this.persistTurn(this.agent.history());
    await this.closeTurn();
    const settlement = await settleSessionTurn(
      this.settling(),
      this.agent.history(),
      "after-turn",
      this.runtime.flushes,
    );
    this.reportSettlement("after-turn", settlement);
    if (settlement.history !== undefined) {
      await this.swap(this.runtime.forge(this.agent.provider, settlement.history));
    }
    this.announce();
    if (this.agent.queued().length === 0) {
      this.runtime.settled(this.turnOutcome, lastReplyIn(this.agent.history()));
    }
  }

  private async settleToolBatch(
    history: readonly Message[],
  ): Promise<readonly Message[] | undefined> {
    const reading = readMeasured(contextMeasureOf(this.agent), history, budgetOf(this.agent));
    if (!compactionDue(reading)) return undefined;
    await this.persistTurn(history);
    const settlement = await settleSessionTurn(
      this.settling(),
      history,
      "between-tool-batches",
      this.runtime.flushes,
    );
    this.reportSettlement("between-tool-batches", settlement);
    if (settlement.history !== undefined) this.persisted = settlement.history.length;
    return settlement.history;
  }

  private persistTurn(history: readonly Message[], submissionId?: string): Promise<MessageEntry[]> {
    const unsaved = history.slice(this.persisted);
    this.persisted = history.length;
    return Promise.all(
      unsaved.map((message, index) =>
        this.store.append(
          message,
          this.usageOf(message),
          undefined,
          index === unsaved.length - 1 && message.role === "user" ? submissionId : undefined,
        ),
      ),
    );
  }

  private usageOf(message: Message): Usage | undefined {
    return message.role === "assistant" ? this.finishedUsage.shift() : undefined;
  }

  private async closeTurn(): Promise<void> {
    const prompt = this.turnPrompt;
    this.turnPrompt = undefined;
    const { checkpoints, turn } = this.runtime;
    if (prompt !== undefined) {
      await freezeTurn(this.store, prompt.id, turn.current(), checkpoints, this.turnEnding());
    }
    turn.close();
  }

  private turnEnding(): TurnEnding {
    switch (this.turnOutcome) {
      case "failed":
        return this.turnFailure === undefined
          ? { outcome: "failed" }
          : { outcome: "failed", error: this.turnFailure };
      case "interrupted":
        return { outcome: this.closing ? "shutdown" : "interrupted" };
      default:
        return { outcome: "completed" };
    }
  }

  private settling(): SettlingSession {
    return {
      sessionId: this.id,
      store: this.store,
      agent: this.agent,
      measure: contextMeasureOf(this.agent),
    };
  }

  private reportSettlement(
    phase: SessionSettlement["phase"],
    settlement: Pick<TurnSettlement, "flushed" | "compacted" | "notices">,
  ): void {
    const quiet =
      settlement.flushed.length === 0 &&
      settlement.compacted === undefined &&
      settlement.notices.length === 0;
    if (quiet) return;
    const report: SessionSettlement = {
      phase,
      flushed: settlement.flushed.length,
      compacted: settlement.compacted ?? null,
      notices: settlement.notices,
    };
    this.runtime.log.record(this.id, "session.settled", report);
  }

  private async providerSeededBy(bot: BotDefinition | undefined): Promise<Provider> {
    const { inference } = this.runtime;
    if (bot?.model === undefined || inference === undefined) return this.agent.provider;
    const bound = inference.bind(bot.model);
    if (!bound.ok) {
      this.runtime.notice(
        `bot ${bot.name} asks for ${bot.model} · ${bound.failure.message} · keeping the session's model`,
      );
      return this.agent.provider;
    }
    const model = bound.binding.reference;
    const provider = inference.provider(bound.binding);
    if (!sameSelection(this.store.modelSelection(), model)) {
      await this.store.appendModelChange(model.provider, model.model);
    }
    return provider;
  }

  private storedProvider(): Provider {
    const selection = this.store.modelSelection();
    const { inference, fallback } = this.runtime;
    if (selection === undefined) return fallback;
    if (inference === undefined) {
      return creatureTagOf(this.store.entries()) === undefined
        ? fallback
        : unavailableSelectedProvider(
            { provider: selection.provider, model: selection.modelId },
            noRegistry,
          );
    }
    const bound = inference.bind(referenceOf(selection));
    if (bound.ok) {
      try {
        return inference.provider(bound.binding);
      } catch (cause) {
        if (
          creatureTagOf(this.store.entries()) === undefined &&
          projectThreadTag(this.store.entries()) === undefined
        )
          throw cause;
        return unavailableSelectedProvider(bound.binding.reference, toError(cause).message);
      }
    }
    if (creatureTagOf(this.store.entries()) !== undefined) {
      return unavailableSelectedProvider(
        { provider: selection.provider, model: selection.modelId },
        bound.failure.message,
      );
    }
    this.runtime.notice(
      `session ${this.id.slice(0, 8)} asked for ${referenceOf(selection)} · ${bound.failure.message} · using the server's model`,
    );
    return fallback;
  }

  private async prepareProvider(): Promise<void> {
    if (this.agent.busy() || this.store.modelSelection() !== undefined) return;
    this.preparing ??= this.prepareInitialProvider().finally(() => {
      this.preparing = undefined;
    });
    await this.preparing;
  }

  private async prepareInitialProvider(): Promise<void> {
    const provider = await this.runtime.initialProvider();
    if (this.agent.busy() || this.store.modelSelection() !== undefined) return;
    await this.swap(this.runtime.forge(provider, this.agent.history()));
    if (provider.modelId !== undefined) {
      await this.store.appendModelChange(provider.name, provider.modelId);
    }
  }

  private adoptStoredSettings(): void {
    const thinking = this.store.thinkingLevel();
    if (thinking === "on" || thinking === "off") this.agent.setThinking(thinking === "on");
    const effort = this.store.effort();
    if (effort !== undefined && isEffortLevel(effort)) this.agent.setEffort(effort);
    this.runtime.ledger.setQuiet(this.id, this.store.quiet());
    const grants = heldGrantsOf(this.store);
    if (grants !== undefined) this.runtime.ledger.adoptSession(this.id, grants);
  }

  private bind(agent: Agent): BoundAgent {
    agent.openTurnsWith(() => this.openTurn(agent));
    agent.settleTurnsWith(() => this.afterTurn());
    agent.settleToolBatchesWith((history) => this.settleToolBatch(history));
    const detach = this.runtime.log.attach(agent.bus, this.id);
    const unfollow = this.runtime.changes.follow(agent.bus, this.id);
    const unmeter = agent.bus.on("turn.delta", ({ delta, replay }) => {
      if (replay === true || delta.type !== "done") return;
      this.finishedUsage.push(delta.usage);
      this.runtime.meter(delta.usage, agent.provider);
    });
    const unfail = agent.bus.on("engine.error", ({ error, replay }) => {
      if (replay !== true) this.runtime.failed(error, agent.provider);
    });
    const untrack = this.trackTurnOutcome(agent);
    return {
      agent,
      bot: this.store.botBinding(),
      journal: tapJournal(agent.bus, this.store),
      keeper: this.tapKeeper(agent),
      detach: () => {
        detach();
        unfollow();
        unmeter();
        unfail();
        untrack();
      },
    };
  }

  private tapKeeper(agent: Agent): KeeperTap | undefined {
    const record = this.runtime.keeper;
    if (record === undefined) return undefined;
    return tapKeeperVerdicts(agent.bus, {
      session: () => this.id,
      context: () =>
        keeperContextOf(creatureTagOf(this.store.entries()), this.runtime.seat()?.workshop),
      cwd: this.store.header.cwd,
      record,
    });
  }

  private trackTurnOutcome(agent: Agent): () => void {
    const stops = [
      agent.bus.on("turn.started", ({ replay }) => {
        if (replay !== true) {
          this.turnOutcome = "failed";
          this.turnFailure = undefined;
        }
      }),
      agent.bus.on("engine.error", ({ error }) => {
        this.turnFailure = error.message;
      }),
      agent.bus.on("turn.completed", ({ replay }) => {
        if (replay !== true) this.turnOutcome = "completed";
      }),
      agent.bus.on("turn.interrupted", ({ replay }) => {
        if (replay !== true) this.turnOutcome = "interrupted";
      }),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }

  private async swap(
    next: Agent,
    effort: EffortLevel | null = this.agent.effort() ?? null,
  ): Promise<void> {
    const previous = this.bound;
    this.spend.retire(previous.agent);
    next.setThinking(previous.agent.thinking());
    if (effort !== null) next.setEffort(effort);
    await this.release(previous);
    next.adoptNotes(previous.agent);
    this.bound = this.bind(next);
    this.persisted = next.history().length;
    next.adoptQueue(previous.agent);
  }

  private async release(bound: BoundAgent): Promise<void> {
    bound.agent.openTurnsWith(undefined);
    bound.agent.settleTurnsWith(undefined);
    bound.agent.settleToolBatchesWith(undefined);
    bound.journal.stop();
    bound.keeper?.stop();
    await bound.journal.flush();
    await bound.keeper?.flush();
    bound.detach();
  }

  private async undoFilesOnly(): Promise<UndoReport | "nothing"> {
    const { checkpoints } = this.runtime;
    if (checkpoints === undefined || !(await checkpoints.undo())) return "nothing";
    await this.runtime.changes.announce(this.id);
    this.announce();
    return { prompt: null, filesNote: "files put back", ...this.travel() };
  }

  private async redoFilesOnly(): Promise<boolean> {
    const { checkpoints } = this.runtime;
    if (checkpoints === undefined || !(await checkpoints.redo())) return false;
    await this.runtime.changes.announce(this.id);
    return true;
  }

  private async pathsGoingBack(turn: number): Promise<readonly string[] | undefined> {
    const { checkpoints } = this.runtime;
    if (checkpoints === undefined) return undefined;
    return sessionPathsFromTurn(checkpoints, this.served(), turn);
  }

  private async stageRewind(
    prompt: MessageEntry,
    paths: readonly string[] | undefined,
    turn?: number,
  ): Promise<Rewound | undefined> {
    const from = this.store.leafId();
    const rewound = rewindBefore(this.store, prompt.id);
    if (rewound === undefined) return undefined;
    const files = await this.stageFiles(rewound.checkpoint, paths).catch((cause: unknown) => {
      rewound.restore();
      throw cause;
    });
    const facts = { from, files: files.restoredTo, redo: files.redoTree, turn, paths: files.paths };
    const restore = await journalRestore(this.store, facts).catch(async (cause: unknown) => {
      await files.restore();
      rewound.restore();
      throw cause;
    });
    await this.swap(this.runtime.forge(this.agent.provider, rewound.history));
    this.staged = this.stagedRestore(restore, files.restore);
    return { files, leafId: restore.id };
  }

  private async stageFiles(
    checkpoint: string | undefined,
    paths: readonly string[] | undefined,
  ): Promise<StagedFiles> {
    const { checkpoints } = this.runtime;
    if (checkpoints === undefined || checkpoint === undefined) return untouchedFiles;
    const left = await checkpoints.snapshot();
    const restored = (await this.putFilesAt(checkpoint, paths)) ?? left;
    return {
      note: "files put back",
      restoredTo: checkpoint,
      redoTree: left,
      paths,
      restore: () => this.putFilesAt(left, paths),
      changed: () => checkpoints.filesBetween(left, restored),
    };
  }

  private reopenedRestore(): StagedUndo | undefined {
    const restore = unsettledRestoreOf(this.store);
    if (restore === undefined) return undefined;
    const { redoFiles } = restore;
    if (redoFiles === undefined) return this.stagedRestore(restore, untouchedFiles.restore);
    if (this.runtime.checkpoints === undefined) return undefined;
    return this.stagedRestore(restore, () => this.putFilesAt(redoFiles, restore.redoPaths));
  }

  private stagedRestore(
    restore: JournaledRestore,
    putFilesBack: () => Promise<unknown>,
  ): StagedUndo {
    return {
      cancel: async () => {
        await undoRestore(this.store, restore);
        await putFilesBack();
        await this.swap(this.runtime.forge(this.agent.provider, this.store.messages()));
      },
    };
  }

  private async putFilesAt(
    tree: string,
    paths: readonly string[] | undefined,
  ): Promise<string | undefined> {
    const restored = await this.runtime.checkpoints?.restoreTo(tree, paths);
    await this.runtime.changes.announce(this.id);
    return restored;
  }
}

type CreatureOrigin = Extract<PromptOrigin, { kind: "creature" }>;

const firstReplyTitleLength = 60;

const noRegistry = "this server was started without a model registry";

const providerDefaultEffort = "default";

function isForgettable(entry: SessionEntry): boolean {
  if (entry.type !== "message") return false;
  return entry.message.role === "user" || entry.message.role === "tool";
}

function checkpointingGuard(
  asks: ToolGuard,
  checkpoints: Checkpoints | undefined,
  turn: TurnCheckpoint,
): ToolGuard {
  if (checkpoints === undefined) return asks;
  return {
    ...asks,
    beforeMutation: async () => turn.note(await checkpoints.captureTree()),
    beforeTurn: () => turn.close(),
  };
}

class TurnCheckpoint {
  private tree: string | undefined;

  note(tree: string): void {
    this.tree ??= tree;
  }

  current(): string | undefined {
    return this.tree;
  }

  close(): void {
    this.tree = undefined;
  }
}

function sendOptionsOf(options: {
  behavior?: SendBehavior | undefined;
  origin?: PromptOrigin | undefined;
}): SendOptions {
  return {
    ...(options.behavior !== undefined && { behavior: options.behavior }),
    ...(options.origin !== undefined && { origin: options.origin }),
  };
}

function lastPromptOnPath(store: SessionStore): MessageEntry | undefined {
  return store.activePath().findLast(isPromptEntry);
}

function textOf(message: Message): string {
  return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function referenceOf(selection: ModelChangeEntry): string {
  return formatReference({ provider: selection.provider, model: selection.modelId });
}

function sameSelection(
  selection: ModelChangeEntry | undefined,
  model: { provider: string; model: string },
): boolean {
  return selection?.provider === model.provider && selection.modelId === model.model;
}

function parentSessionOf(store: SessionStore): { parentSession?: string } {
  const { parentSession } = store.header;
  return parentSession === undefined ? {} : { parentSession };
}

function storedSummary(summary: StoredSummary, store: SessionStore): SessionSummary {
  const selection = store.modelSelection();
  const thinking = store.thinkingLevel();
  const effort = store.effort();
  return {
    id: summary.id,
    title: summary.title,
    createdAt: summary.createdAt,
    lastActivityAt: summary.lastActivityAt,
    messageCount: summary.messageCount,
    ...(summary.costNanos !== undefined && { costNanos: summary.costNanos }),
    ...(summary.arc !== undefined && { arc: summary.arc }),
    ...(summary.bot !== undefined && { bot: summary.bot }),
    ...(selection !== undefined && { model: referenceOf(selection) }),
    ...((thinking === "on" || thinking === "off") && { thinking: thinking === "on" }),
    ...(effort !== undefined && isEffortLevel(effort) && { effort }),
  };
}

function lifecycleOf(sessions: LiveSessions): LifecycleSessions {
  return {
    sessionDir: sessions.sessionDir,
    bound: (id) => sessions.bound(id),
    release: (id) => sessions.release(id),
    summaryOf: storedSummary,
  };
}

function creatureSessionsOf(
  sessions: LiveSessions,
  { asks }: ServedGate,
  log: EventLog,
): ServedCreatureSessions {
  return {
    stored: () => storesWithChildren(sessions.sessionDir),
    working: (id) => sessions.liveOnly(id)?.busy() === true,
    waiting: (id) => asks.list().filter((ask) => ask.sessionId === id).length,
    openClaimed: (tag) => sessions.openClaimed(tag),
    inject: async (id, text, origin) => (await sessions.open(id))?.note(text, origin) ?? "missing",
    trash: async (id) => {
      const outcome = await trashSession(lifecycleOf(sessions), id);
      if (outcome === "busy") throw new SessionBusyError();
      if (outcome !== "missing") log.record("", "session.removed", { sessionId: id });
    },
  };
}

async function storesWithChildren(sessionDir: string): Promise<SessionStore[]> {
  const { stores } = await scanSessions(sessionDir);
  const children = await Promise.all(
    stores.map(async (store) => (await scanSessions(childDirFor(store.file))).stores),
  );
  return [...stores, ...children.flat()];
}

function routineSessionsOf(
  sessions: LiveSessions,
  verbs: SessionHost,
  creatures: { openThread(creature: string, kind: "routine"): Promise<string> },
  { asks }: ServedGate,
): RoutineSessions {
  return {
    openThread: async (thread) => {
      const id = await creatures.openThread(thread.creature, thread.kind);
      await verbs.rename(id, thread.title);
      return id;
    },
    confine: async (id, posture, grants) => sessions.confine(id, posture, grants),
    prompt: (id, text) => verbs.prompt(id, text, "queue"),
    abort: (id) => verbs.abort(id),
    denyAsk: async (callId) => asks.answer(callId, "denied"),
    costUsd: async (id) => {
      const nanos = sessions.liveOnly(id)?.costNanos();
      return nanos === undefined ? null : nanos / nanosPerDollar;
    },
  };
}

interface KeeperDeciderSeams {
  nodeState: string;
  log: Pick<EventLog, "record">;
  stored(id: string): Promise<SessionStore | undefined>;
  workshopOf(id: string): string | undefined;
}

export function keeperDecider(seams: KeeperDeciderSeams): AskDecider {
  return async (ask, announced) => {
    if (announced === undefined) return undefined;
    const store = await seams.stored(ask.sessionId);
    if (store === undefined) return undefined;
    const tag = creatureTagOf(store.entries());
    const ruling = await decideForKeeper(
      {
        ask: announced,
        session: ask.sessionId,
        context: keeperContextOf(tag, seams.workshopOf(ask.sessionId)),
        cwd: store.header.cwd,
      },
      { nodeState: seams.nodeState },
    );
    if (!ruling.decidedForYou) return undefined;
    seams.log.record(ask.sessionId, "extension.notice", {
      extension: "keeper",
      level: "info",
      message: decidedForYouLine(ask.tool, ruling.ruleClass, ruling.recordId),
      detail: {
        recordId: ruling.recordId,
        ruleClass: ruling.ruleClass,
        callId: ask.callId,
        tool: ask.tool,
        ...(tag !== undefined && { creature: tag.creature }),
      },
    });
    return { approved: true, gate: "headless", asked: true };
  };
}

export function decidedForYouLine(tool: string, ruleClass: string, recordId: string): string {
  return `decided for you: ${tool} (${ruleClass}) · overturn it with POST /creatures/{slug}/overturn { recordId: "${recordId}" }`;
}

function servedMail(
  mesh: HouseMeshConsole,
  creatures: Pick<CreatureHost, "inbound" | "deliver">,
  memory: () => MemoryStore | undefined,
): CreatureMail {
  return creatureMail({
    mailboxes: stagingMailboxes(creatures, memory),
    pairs: () => mesh.pairing.pairs(),
    client: mesh.client,
    audit: mesh.audit,
    self: mesh.self,
    machine: mesh.machine,
  });
}

function stagingMailboxes(
  creatures: Pick<CreatureHost, "inbound" | "deliver">,
  memory: () => MemoryStore | undefined,
): Mailboxes {
  return {
    inbound: (creature) => creatures.inbound(creature),
    deliver: async (creature, text, origin) => {
      const outcome = await creatures.deliver(creature, text, origin);
      const store = memory();
      if (outcome === "missing" || store === undefined) return outcome;
      await rememberFrom(
        store,
        { kind: "creature", id: origin.creature },
        {
          title: `message from ${origin.creature} ${origin.thread.slice(0, 8)}`,
          body: text,
          self: creature,
        },
      ).catch(() => undefined);
      return outcome;
    },
  };
}

function grantsHeldBy(ledger: PermissionLedger, sessionId: string): PermissionRule[] {
  const view = ledger.view();
  return [...view.bundle, ...view.workspace, ...(view.session[sessionId] ?? [])];
}

function lastReplyIn(history: readonly Message[]): string {
  const reply = history.findLast((message) => message.role === "assistant");
  return reply === undefined ? "" : textOf(reply);
}

const nanosPerDollar = 1_000_000_000;

function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
