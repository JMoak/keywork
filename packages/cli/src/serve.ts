import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type Agent,
  type BotDefinition,
  type Checkpoints,
  type CompactionEntry,
  compactNow,
  contextBudgetFor,
  declaredContextWindow,
  type EffortLevel,
  type JournalTap,
  type MemoryFlush,
  type Message,
  type MessageEntry,
  messageText,
  modelReferenceOf,
  type PermissionLedger,
  type PermissionResolver,
  type PromptOrigin,
  type Provider,
  parseReference,
  type SendBehavior,
  SessionStore,
  ShellSession,
  scopeContains,
  type ToolGuard,
  type ToolScope,
  tapJournal,
  UsageLedger,
} from "@keywork/engine";
import {
  AskQueue,
  announceChanges,
  type BindOutcome,
  type BoundModel,
  type ChangeSource,
  type ChangesOutcome,
  type CheckpointsOutcome,
  type CompactOutcome,
  type ContextReport,
  type CostReport,
  changedFileOf,
  changedFilesOf,
  contextReportOf,
  costReportOf,
  type EffortOutcome,
  EventLog,
  type ExportOutcome,
  type ExportRequest,
  entriesOf,
  type FileRange,
  type ForkOutcome,
  issueToken,
  type LabelOutcome,
  type LeafOutcome,
  listen,
  type MemoryHost,
  type MemoryWorkspace,
  type ModelOutcome,
  memoryHost,
  moveLeafOf,
  type OwnedStagedItem,
  type PresetOutcome,
  processLevelSessionId,
  type RedoOutcome,
  type RenameOutcome,
  readServerTicket,
  removeServerTicket,
  type ServerTicket,
  type SessionDetail,
  type SessionEntries,
  type SessionHost,
  type SessionInference,
  type SessionState,
  type SessionSummary,
  type SpillOutcome,
  type SwitchBotOutcome,
  spillSliceOf,
  type ThinkingOutcome,
  treeChange,
  type UndoOutcome,
  type WorkspaceInfo,
  writeServerTicket,
} from "@keywork/server";
import {
  type KeyworkConfig,
  type LspConfig,
  type McpServerConfig,
  type ModelCapabilitiesConfig,
  type PromptsConfig,
  requiresConfirmation,
  resolveAnchor,
  TrustStore,
} from "@keywork/shared";
import { type AnchorMemory, anchorMemoryFile, fileAnchorMemory } from "./anchor.ts";
import { type ArcService, arcService } from "./arcs.ts";
import { type BotMemory, botMemory } from "./bot-memory.ts";
import { botService } from "./bots.ts";
import { persistNewMessages } from "./chat.ts";
import {
  type AgentComposition,
  type Composition,
  composeAgents,
  composeWorkspace,
} from "./compose.ts";
import { type CitationTrail, citationTrail, memoryBootstrapBudget } from "./memory.ts";
import { defaultSessionDir, keyworkHome, workspaceIdentity } from "./paths.ts";
import type { PresetPort } from "./presets.ts";
import { type SurfaceComposition, surfaceHost, watchSurfaces } from "./serve-surfaces.ts";
import { workspaceHost } from "./serve-workspace.ts";
import { exportSession } from "./sessions/export.ts";
import { sessionHtml } from "./sessions/export-html.ts";
import { boundSessionCounts, rewindBefore } from "./sessions/ports.ts";
import {
  effortOf,
  findSession,
  listSessions,
  newSessionFileName,
  type SessionSummary as StoredSummary,
  selectedModelOf,
  summarize,
  thinkingSwitchOf,
} from "./sessions/store.ts";
import { keyworkVersion } from "./version.ts";
import { workspacePermissions } from "./workspace-permissions.ts";
import { fileWorkspaceRecall, type WorkspaceRecall, workspaceRecallFile } from "./workspaces.ts";

export interface ServeOptions extends HostOptions {
  port?: number | undefined;
  ticketFile?: string | undefined;
  fetch?: typeof fetch | undefined;
  signal: AbortSignal;
  print: (line: string) => void;
  printError: (line: string) => void;
}

export interface HostOptions {
  cwd: string;
  projectTrusted: boolean;
  provider: Provider;
  permissions: PermissionResolver;
  inference?: SessionInference | undefined;
  presets?: PresetPort | undefined;
  checkpoints?: "on" | "off" | undefined;
  checkpointsGitDir?: string | undefined;
  askTimeoutMs?: number | undefined;
  workspaceSlug?: string | undefined;
  sessionDir?: string | undefined;
  userRoot?: string | undefined;
  trustStore?: TrustStore | undefined;
  anchorMemory?: AnchorMemory | undefined;
  workspaceRecall?: WorkspaceRecall | undefined;
  theme?: string | undefined;
  prompts?: PromptsConfig | undefined;
  mcpServers?: Record<string, McpServerConfig> | undefined;
  repoMap?: "auto" | "off" | undefined;
  lsp?: LspConfig | undefined;
  models?: ModelCapabilitiesConfig | undefined;
  thinking?: KeyworkConfig["thinking"] | undefined;
  notice?: ((text: string) => void) | undefined;
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
  const ticketFiles =
    options.ticketFile === undefined
      ? ticketFilesFor(options.cwd, options.workspaceSlug, options.userRoot)
      : [options.ticketFile];
  const running = await runningServerAmong(ticketFiles, options.fetch ?? fetch);
  if (running !== undefined) {
    options.printError(
      `keywork serve: a keywork server for this workspace is already listening at ${running.url} · attach to it, or stop it first`,
    );
    return alreadyServingExit;
  }
  const log = new EventLog();
  const host = fileSessionHost({ ...options, log, notice: options.printError });
  const token = issueToken();
  let server: Awaited<ReturnType<typeof listen>>;
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
  for (const file of ticketFiles) writeServerTicket(file, { url: server.url, token });
  options.print(`listening on ${server.url}`);
  options.print(`token ${token}`);
  for (const file of ticketFiles) options.print(`ticket ${file}`);
  await untilAborted(options.signal);
  await server.close();
  for (const file of ticketFiles) removeServerTicket(file);
  return 0;
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

export function fileSessionHost(options: HostOptions & { log: EventLog }): SessionHost {
  const userRoot = options.userRoot ?? homedir();
  const ledger = workspacePermissions({ ...options, userRoot, user: options.permissions });
  const asks = new AskQueue({
    grants: ledger,
    ...(options.askTimeoutMs !== undefined && { timeoutMs: options.askTimeoutMs }),
  });
  const sessions = new LiveSessions(options, asks, ledger);
  const opened = async <T>(id: string, verb: (live: LiveSession) => Promise<T> | T) => {
    const live = await sessions.open(id);
    return live === undefined ? ("missing" as const) : verb(live);
  };
  const trustStore = options.trustStore ?? new TrustStore({ home: userRoot });
  const anchorMemory = options.anchorMemory ?? fileAnchorMemory(anchorMemoryFile(userRoot));
  const place = {
    cwd: options.cwd,
    projectTrusted: options.projectTrusted,
    workspaceSlug: options.workspaceSlug,
    trustStore,
    anchorMemory,
    log: options.log,
  };
  return {
    ...workspaceHost({ ...place, theme: options.theme }),
    ...surfaceHost({
      ...place,
      sessionDir: sessions.sessionDir,
      workspaceRecall:
        options.workspaceRecall ?? fileWorkspaceRecall(workspaceRecallFile(keyworkHome(userRoot))),
      sessionDirFor: (slug) =>
        slug === options.workspaceSlug ? sessions.sessionDir : defaultSessionDir(options.cwd, slug),
      composed: () => sessions.surfaces(),
      sessions: {
        bindArc: (id, slug) => sessions.bindArc(id, slug),
        switchBot: (id, bot) => sessions.switchBot(id, bot),
      },
    }),
    list: () => sessions.list(),
    read: (id) => sessions.read(id),
    create: () => sessions.create(),
    prompt: (id, text, behavior) => opened(id, (live) => live.run(text, behavior)),
    inject: (id, text, origin) => opened(id, (live) => live.run(text, "queue", origin)),
    abort: async (id) => {
      const live = sessions.liveOnly(id);
      if (live !== undefined) return live.interrupt();
      return (await sessions.stored(id)) === undefined ? "missing" : "idle";
    },
    entries: (id) => sessions.entries(id),
    fork: (id, entryId) => sessions.fork(id, entryId),
    label: (id, entryId, label) => sessions.label(id, entryId, label),
    moveLeaf: (id, entryId) => sessions.moveLeaf(id, entryId),
    changes: (id) => sessions.changes(id, changedFilesOf),
    changedFile: (id, path) => sessions.changes(id, (source) => changedFileOf(source, path)),
    spill: (id, spillId, range) => sessions.spill(id, spillId, range),
    setModel: (id, reference) => opened(id, (live) => live.setModel(reference)),
    setThinking: (id, on) => opened(id, (live) => live.setThinking(on)),
    setEffort: (id, level) => opened(id, (live) => live.setEffort(level)),
    compact: (id, focus) => opened(id, (live) => live.compact(focus)),
    undo: (id) => opened(id, (live) => live.undo()),
    redo: (id) => opened(id, (live) => live.redo()),
    context: (id) => opened(id, (live) => live.context()),
    cost: (id) => opened(id, (live) => live.cost()),
    export: (id, request) => opened(id, (live) => live.export(request)),
    rename: (id, title) => opened(id, (live) => live.rename(title)),
    checkpointsOf: (id) => sessions.checkpointsOf(id),
    setPreset: (name, confirmed) => sessions.setPreset(name, confirmed),
    asks: async () => asks.list(),
    answerAsk: async (callId, verdict, scope) => asks.answer(callId, verdict, scope),
    permissions: async () => ledger.view(),
    revokeWorkspaceGrant: async (rule) => ledger.revokeWorkspace(rule),
    memory: sessions.memory,
    close: async () => {
      asks.close();
      await sessions.close();
    },
  };
}

interface Composed extends SurfaceComposition {
  composition: Composition;
  agents: AgentComposition;
  botMemory: BotMemory;
  citations: CitationTrail;
  unwatch: () => void;
}

class LiveSessions {
  readonly sessionDir: string;
  readonly memory: MemoryHost;
  private readonly live = new Map<string, LiveSession>();
  private workspace: Promise<Composed> | undefined;

  constructor(
    private readonly options: HostOptions & { log: EventLog },
    private readonly asks: AskQueue,
    private readonly ledger: PermissionLedger,
  ) {
    this.sessionDir = options.sessionDir ?? defaultSessionDir(options.cwd, options.workspaceSlug);
    this.memory = memoryHost({
      log: options.log,
      bootstrapBudget: memoryBootstrapBudget,
      workspace: () => this.memoryWorkspace(),
    });
  }

  async list(): Promise<SessionSummary[]> {
    const { sessions } = await listSessions(this.sessionDir);
    const listed = sessions.map(
      (summary) => this.live.get(summary.id)?.summary() ?? publicSummary(summary),
    );
    const unlisted = [...this.live.values()]
      .filter((live) => !listed.some((summary) => summary.id === live.id))
      .map((live) => live.summary());
    return [...unlisted, ...listed];
  }

  async read(id: string): Promise<SessionDetail | undefined> {
    const live = this.liveOnly(id);
    if (live !== undefined) return live.detail(this.options.log.latestId());
    const store = await this.stored(id);
    if (store === undefined) return undefined;
    return {
      ...publicSummary(await summarize(store)),
      cwd: store.header.cwd,
      live: false,
      messages: store.messages(),
      asOf: this.options.log.latestId(),
    };
  }

  async create(): Promise<SessionSummary> {
    const store = await SessionStore.create(
      join(this.sessionDir, newSessionFileName()),
      this.options.cwd,
    );
    return (await this.adopt(store)).summary();
  }

  async open(id: string): Promise<LiveSession | undefined> {
    const live = this.liveOnly(id);
    if (live !== undefined) return live;
    const store = await this.stored(id);
    return store === undefined ? undefined : this.adopt(store);
  }

  liveOnly(id: string): LiveSession | undefined {
    return this.live.get(id);
  }

  stored(id: string): Promise<SessionStore | undefined> {
    return findSession(this.sessionDir, id);
  }

  async entries(id: string): Promise<SessionEntries | undefined> {
    const store = await this.storeOf(id);
    return store === undefined ? undefined : entriesOf(store);
  }

  async fork(id: string, entryId: string): Promise<ForkOutcome> {
    const store = await this.storeOf(id);
    if (store === undefined) return "missing";
    if (store.entry(entryId) === undefined) return "unknown-entry";
    const clone = await store.clone(join(this.sessionDir, newSessionFileName()), entryId);
    this.announceTree(store, "fork", { entryId, forkedTo: clone.header.id });
    return publicSummary(await summarize(clone));
  }

  async label(id: string, entryId: string, label: string | undefined): Promise<LabelOutcome> {
    const store = await this.storeOf(id);
    if (store === undefined) return "missing";
    if (store.entry(entryId) === undefined) return "unknown-entry";
    await store.setLabel(entryId, label);
    this.announceTree(store, "label", { entryId });
    return "labelled";
  }

  async moveLeaf(id: string, entryId: string | null): Promise<LeafOutcome> {
    const live = await this.open(id);
    if (live === undefined) return "missing";
    const moved = await live.moveLeaf(entryId);
    if (typeof moved === "string") return moved;
    this.announceTree(live.store, "leaf", entryId === null ? {} : { entryId });
    return moved;
  }

  async changes<Reading>(
    id: string,
    read: (source: ChangeSource) => Promise<Reading>,
  ): Promise<ChangesOutcome<Reading>> {
    if ((await this.storeOf(id)) === undefined) return "missing";
    if (!this.options.projectTrusted) return "untrusted";
    const source = await this.changeSource();
    return source === undefined ? "no-baseline" : read(source);
  }

  async spill(id: string, spillId: string, range: FileRange): Promise<SpillOutcome> {
    const store = await this.storeOf(id);
    return store === undefined ? "missing" : spillSliceOf(store.spills(), spillId, range);
  }

  async checkpointsOf(id: string): Promise<CheckpointsOutcome> {
    if ((await this.storeOf(id)) === undefined) return "missing";
    const { composition } = await this.composed();
    return composition.checkpoints ?? "off";
  }

  async setPreset(
    name: Parameters<SessionHost["setPreset"]>[0],
    confirmed: boolean,
  ): Promise<PresetOutcome> {
    const presets = this.options.presets;
    if (presets === undefined) return "unavailable";
    const from = presets.active();
    if (from === name) return { from, to: name };
    if (requiresConfirmation(from, name) && !confirmed) return "needs-confirmation";
    await presets.apply(name);
    this.options.log.record(processLevelSessionId, "gate.preset", { from, to: name });
    return { from, to: name };
  }

  surfaces(): Promise<SurfaceComposition> {
    return this.composed();
  }

  async bindArc(id: string, slug: string | undefined): Promise<BindOutcome> {
    const live = await this.open(id);
    if (live === undefined) return "missing";
    const { arcs } = await this.composed();
    await live.bindArc(slug);
    arcs.recordBinding(id, slug);
    return "bound";
  }

  async switchBot(id: string, bot: BotDefinition | undefined): Promise<SwitchBotOutcome> {
    const live = await this.open(id);
    if (live === undefined) return "missing";
    return live.switchBot(bot);
  }

  async close(): Promise<void> {
    for (const live of this.live.values()) await this.release(live);
    this.live.clear();
    if (this.workspace === undefined) return;
    const { composition, unwatch } = await this.workspace;
    unwatch();
    await composition.languagePort?.dispose();
    await composition.mcp?.stop();
  }

  private async storeOf(id: string): Promise<SessionStore | undefined> {
    return this.liveOnly(id)?.store ?? (await this.stored(id));
  }

  private async changeSource(): Promise<ChangeSource | undefined> {
    const { checkpoints } = (await this.composed()).composition;
    if (checkpoints === undefined) return undefined;
    const { cwd } = this.options;
    return {
      checkpoints,
      readWorkingFile: (path) => readFile(resolve(cwd, path), "utf8").catch(() => undefined),
    };
  }

  private announceTree(
    store: SessionStore,
    reason: "fork" | "label" | "leaf",
    detail: { entryId?: string; forkedTo?: string },
  ): void {
    this.options.log.record(store.header.id, "session.tree", treeChange(store, reason, detail));
  }

  private async adopt(store: SessionStore): Promise<LiveSession> {
    const { agents, arcs, citations, composition } = await this.composed();
    const id = store.header.id;
    const shell = new ShellSession(this.options.cwd);
    const guard = this.guardFor(id, composition.checkpoints);
    const spills = store.spills();
    const build: AgentBuild = (history, provider, bus, bot) =>
      agents.build({
        provider,
        guard,
        shell,
        history,
        sessionId: id,
        spills,
        permissions: this.ledger.resolverFor(id),
        ...(bus !== undefined && { bus }),
        ...(bot !== undefined && { bot }),
      });
    const agent = build(store.messages(), this.providerFor(store));
    adoptSessionSettings(agent, store);
    const live = new LiveSession(store, agent, shell, {
      log: this.options.log,
      checkpoints: composition.checkpoints,
      scope: composition.scope,
      cwd: this.options.cwd,
      inference: this.options.inference,
      build,
      flushFor: (provider) => agents.flushFor(id, provider),
      afterTurn: () => this.memory.recount(),
    });
    live.announceChangesFrom(await this.changeSource());
    this.live.set(id, live);
    citations.forSession(id);
    await arcs.attached(store);
    return live;
  }

  private guardFor(id: string, checkpoints: Checkpoints | undefined): ToolGuard {
    return {
      ...this.asks.guardFor(id),
      ...(checkpoints !== undefined && {
        beforeMutation: () => checkpoints.capture(),
        beforeTurn: () => checkpoints.beginTurn(),
      }),
    };
  }

  private providerFor(store: SessionStore): Provider {
    const inference = this.options.inference;
    if (inference === undefined) return this.options.provider;
    const selection = selectedModelOf(store);
    const bound = inference.bind(selection);
    if (bound.ok) return bound.provider;
    this.options.notice?.(
      `keywork serve: session ${store.header.id} asked for ${selection ?? "the default model"} · ${bound.failure.message} · using the process provider`,
    );
    return this.options.provider;
  }

  private async release(live: LiveSession): Promise<void> {
    await live.close();
    const { agents, arcs, citations } = await this.composed();
    agents.release(live.id);
    arcs.released(live.id);
    citations.release(live.id);
  }

  private async memoryWorkspace(): Promise<MemoryWorkspace> {
    const { composition, arcs, botMemory } = await this.composed();
    return {
      vault: composition.memory(),
      arcs: arcs.registry(),
      airlock: arcs.port.airlock,
      botInbox: () => ownedStagedItems(botMemory),
    };
  }

  private composed(): Promise<Composed> {
    this.workspace ??= this.compose();
    return this.workspace;
  }

  private async compose(): Promise<Composed> {
    const { options } = this;
    const userRoot = options.userRoot ?? homedir();
    const composition = await composeWorkspace({
      cwd: options.cwd,
      projectTrusted: options.projectTrusted,
      workspaceSlug: options.workspaceSlug,
      prompts: options.prompts,
      mcpServers: options.mcpServers,
      repoMap: options.repoMap,
      models: options.models,
      checkpoints: options.checkpoints ?? "on",
      checkpointsGitDir: options.checkpointsGitDir,
      reportCheckpointsUnavailable: (message) =>
        options.notice?.(`keywork serve: can't undo files: ${message}`),
      lsp: options.lsp,
      notice: (text) => options.notice?.(`keywork serve: ${text}`),
      userRoot,
    });
    for (const failure of composition.extensions.failures) {
      options.notice?.(`keywork serve: skipped extension ${failure.file} · ${failure.reason}`);
    }
    const citations = citationTrail(composition.memory, () => composition.bootstrap);
    const arcs = this.arcServiceOver(composition, citations, () => agents);
    const memoryBots = this.botMemoryOver(composition, userRoot);
    await memoryBots.prepare();
    const agents = composeAgents(composition, {
      permissions: options.permissions,
      thinking: options.thinking === "on",
      arcs,
      bots: memoryBots,
      citations,
    });
    const bots = botService({
      cwd: options.cwd,
      projectTrusted: options.projectTrusted,
      userRoot,
      sessionDir: this.sessionDir,
      roster: composition.extensions.bots,
    });
    const composed = {
      composition,
      agents,
      arcs,
      bots,
      botMemory: memoryBots,
      citations,
      roster: composition.extensions.bots,
      mcp: composition.mcp,
    };
    return { ...composed, unwatch: watchSurfaces(composed, options.log) };
  }

  private arcServiceOver(
    composition: Composition,
    citations: CitationTrail,
    agents: () => AgentComposition,
  ): ArcService {
    const { options } = this;
    return arcService({
      cwd: options.cwd,
      trusted: options.projectTrusted,
      workspaceSlug: options.workspaceSlug,
      memory: composition.memory,
      boundSessionCounts: () => boundSessionCounts(this.sessionDir),
      flushFor: (sessionId) => this.flushFor(sessionId, agents()),
      citedNotes: (slug) => citations.citedNotes(slug),
    });
  }

  private botMemoryOver(composition: Composition, userRoot: string): BotMemory {
    const { options } = this;
    return botMemory({
      cwd: options.cwd,
      projectTrusted: options.projectTrusted,
      workspaceSlug: options.workspaceSlug,
      userRoot,
      memory: composition.memory,
      roster: composition.extensions.bots,
      bindingOf: (sessionId) => this.live.get(sessionId)?.botBinding(),
      skills: composition.extensions.skills,
    });
  }

  private flushFor(
    sessionId: string,
    agents: AgentComposition,
  ): (() => Promise<unknown>) | undefined {
    const live = this.live.get(sessionId);
    if (live === undefined) return undefined;
    const flush = agents.flushOf(sessionId);
    return flush === undefined ? async () => undefined : () => flush.flushNow(live.messages());
  }
}

async function ownedStagedItems(bots: BotMemory): Promise<OwnedStagedItem[]> {
  return (await bots.staged()).map((owned) => ({
    bot: owned.bot.name,
    item: owned.item,
    approve: () => bots.approve(owned),
    discard: () => owned.registry.botStore(owned.bot.name).discard(owned.item.id),
  }));
}

type AgentBuild = (
  history: readonly Message[],
  provider: Provider,
  bus?: Agent["bus"],
  bot?: BotDefinition,
) => Agent;

interface LiveSessionSeams {
  log: EventLog;
  checkpoints: Checkpoints | undefined;
  scope: ToolScope;
  cwd: string;
  inference: SessionInference | undefined;
  build: AgentBuild;
  flushFor(provider: Provider): MemoryFlush | undefined;
  afterTurn(): Promise<void>;
}

interface StagedUndo {
  cancel(): Promise<void>;
}

interface StagedFiles {
  note: string;
  restore(): Promise<void>;
}

const untouchedFiles: StagedFiles = { note: "files untouched", restore: async () => {} };

const providerDefaultEffort = "default";

class LiveSession {
  readonly id: string;
  private agent: Agent;
  private bot: BotDefinition | undefined;
  private readonly journal: JournalTap;
  private readonly stops: Array<() => void | Promise<void>> = [];
  private readonly ledger = new UsageLedger();
  private persisted: number;
  private settled: Promise<void> = Promise.resolve();
  private staged: StagedUndo | undefined;

  constructor(
    readonly store: SessionStore,
    agent: Agent,
    private readonly shell: ShellSession,
    private readonly seams: LiveSessionSeams,
  ) {
    this.id = store.header.id;
    this.agent = agent;
    this.persisted = agent.history().length;
    this.journal = tapJournal(agent.bus, store);
    this.stops.push(seams.log.attach(agent.bus, this.id));
  }

  announceChangesFrom(source: ChangeSource | undefined): void {
    if (source === undefined) return;
    this.stops.push(
      announceChanges(this.agent.bus, source, (paths) =>
        this.seams.log.record(this.id, "changes.updated", { sessionId: this.id, paths }),
      ),
    );
  }

  run(text: string, behavior: SendBehavior, origin?: PromptOrigin): "started" | "queued" {
    const outcome = this.agent.busy() ? "queued" : "started";
    this.staged = undefined;
    this.settled = this.agent
      .send(text, { behavior, ...(origin !== undefined && { origin }) })
      .catch(() => undefined)
      .then(() => this.persist())
      .then(() => this.seams.afterTurn().catch(() => undefined));
    return outcome;
  }

  interrupt(): "aborted" | "idle" {
    if (!this.agent.busy()) return "idle";
    this.agent.interrupt();
    return "aborted";
  }

  busy(): boolean {
    return this.agent.busy();
  }

  messages(): readonly Message[] {
    return this.store.messages();
  }

  botBinding(): string | undefined {
    return this.store.botBinding();
  }

  async moveLeaf(entryId: string | null): Promise<LeafOutcome> {
    if (!(await this.quiet())) return "busy";
    if (!moveLeafOf(this.store, entryId)) return "unknown-entry";
    this.staged = undefined;
    this.swap(this.rebuild(this.store.messages()));
    this.announce();
    return { leafId: this.store.leafId() };
  }

  async switchBot(bot: BotDefinition | undefined): Promise<SwitchBotOutcome> {
    if (this.agent.busy()) return "busy";
    this.bot = bot;
    this.swap(this.rebuild(this.agent.history()));
    if (this.store.botBinding() !== bot?.name) await this.store.appendBotBinding(bot?.name);
    return "switched";
  }

  async bindArc(slug: string | undefined): Promise<void> {
    if (this.store.arcBinding() !== slug) await this.store.appendArcBinding(slug);
  }

  async setModel(reference: string): Promise<ModelOutcome> {
    if (!(await this.quiet())) return "busy";
    const bound = this.bind(reference);
    if (!bound.ok) return bound;
    this.swap(this.rebuild(this.agent.history(), bound.provider));
    const model = parseReference(bound.reference) ?? {
      provider: bound.provider.name,
      model: bound.reference,
    };
    const current = this.store.modelSelection();
    if (current?.provider !== model.provider || current.modelId !== model.model) {
      await this.store.appendModelChange(model.provider, model.model);
    }
    this.announce();
    return { ok: true, model, notice: `model → ${bound.reference}` };
  }

  async setThinking(on: boolean): Promise<ThinkingOutcome> {
    this.agent.setThinking(on);
    const level = on ? "on" : "off";
    if (this.store.thinkingLevel() !== level) await this.store.appendThinkingLevelChange(level);
    this.announce();
    return { thinking: on };
  }

  async setEffort(level: EffortLevel | null): Promise<EffortOutcome> {
    this.agent.setEffort(level ?? undefined);
    const recorded = level ?? providerDefaultEffort;
    if (this.store.effort() !== recorded) await this.store.appendEffortChange(recorded);
    this.announce();
    return { effort: level };
  }

  async compact(focus: string | undefined): Promise<CompactOutcome> {
    if (!(await this.quiet())) return "busy";
    let compacted: CompactionEntry | undefined;
    let notices: readonly string[] = [];
    await this.agent.hold(async () => {
      const agent = this.agent;
      const settlement = await compactNow({
        store: this.store,
        provider: agent.provider,
        budget: contextBudgetFor(declaredContextWindow(agent.provider)),
        instructions: focus,
        flush: this.seams.flushFor(agent.provider),
      });
      if (settlement.history !== undefined) this.swap(this.rebuild(settlement.history));
      compacted = settlement.compacted;
      notices = settlement.notices;
    });
    this.announce();
    return { compacted: compacted ?? null, notices };
  }

  async undo(): Promise<UndoOutcome> {
    if (!(await this.quiet())) return "busy";
    if (this.staged !== undefined) return "staged";
    const prompt = lastPromptOf(this.store);
    if (prompt === undefined) return this.undoFilesOnly();
    const rewound = rewindBefore(this.store, prompt.id);
    if (rewound === undefined) return "nothing";
    this.swap(this.rebuild(rewound.history));
    const files = await this.stageFiles(rewound.checkpoint).catch((cause: unknown) => {
      this.swap(this.rebuild(rewound.restore()));
      throw cause;
    });
    this.staged = {
      cancel: async () => {
        await files.restore();
        this.swap(this.rebuild(rewound.restore()));
      },
    };
    this.announce();
    return {
      prompt: { entryId: prompt.id, text: messageText(prompt.message) },
      filesNote: files.note,
      undoable: this.undoable(),
      redoable: true,
    };
  }

  async redo(): Promise<RedoOutcome> {
    if (!(await this.quiet())) return "busy";
    const staged = this.staged;
    if (staged !== undefined) {
      this.staged = undefined;
      await staged.cancel();
      this.announce();
      return { restored: true, undoable: this.undoable(), redoable: this.redoable() };
    }
    const { checkpoints } = this.seams;
    if (checkpoints === undefined || !(await checkpoints.redo())) return "nothing";
    this.announce();
    return { restored: true, undoable: this.undoable(), redoable: this.redoable() };
  }

  context(): ContextReport {
    return contextReportOf(this.agent);
  }

  cost(): CostReport {
    return costReportOf(this.agent, this.ledger);
  }

  async export(request: ExportRequest): Promise<ExportOutcome> {
    if (request.out === undefined) return { html: sessionHtml(this.store, request.scope) };
    if (!scopeContains(this.seams.scope, request.out)) {
      return { refused: `${request.out} escapes the workspace scope` };
    }
    const file = await exportSession(this.store, { ...request, cwd: this.seams.cwd });
    return { file };
  }

  async rename(title: string): Promise<RenameOutcome> {
    await this.store.setName(title);
    this.announce();
    return { title };
  }

  summary(): SessionSummary {
    const stats = this.store.stats();
    const model = modelReferenceOf(this.agent.provider) ?? selectedModelOf(this.store);
    const effort = this.agent.effort();
    const arc = this.store.arcBinding();
    const bot = this.store.botBinding();
    return {
      id: this.id,
      title: this.store.name() ?? "(untitled session)",
      createdAt: this.store.header.timestamp,
      lastActivityAt: stats.lastActivityAt,
      messageCount: this.agent.history().length,
      ...(model !== undefined && { model }),
      thinking: this.agent.thinking(),
      ...(effort !== undefined && { effort }),
      ...(arc !== undefined && { arc }),
      ...(bot !== undefined && { bot }),
    };
  }

  detail(asOf: number): SessionDetail {
    return {
      ...this.summary(),
      cwd: this.store.header.cwd,
      live: true,
      messages: this.agent.history(),
      asOf,
    };
  }

  async close(): Promise<void> {
    this.agent.interrupt();
    await this.settled;
    this.journal.stop();
    await this.journal.flush();
    for (const stop of this.stops) await stop();
    await this.shell.close();
  }

  private async quiet(): Promise<boolean> {
    if (this.agent.busy()) return false;
    await this.settled;
    return !this.agent.busy();
  }

  private rebuild(history: readonly Message[], provider = this.agent.provider): Agent {
    return this.seams.build(history, provider, this.agent.bus, this.bot);
  }

  private bind(reference: string): BoundModel {
    const { inference } = this.seams;
    if (inference !== undefined) return inference.bind(reference);
    return {
      ok: false,
      failure: {
        code: "unconfigured",
        message: "this server has no inference runtime to resolve models with",
        available: [],
      },
    };
  }

  private async undoFilesOnly(): Promise<UndoOutcome> {
    const { checkpoints } = this.seams;
    if (checkpoints === undefined || !(await checkpoints.undo())) return "nothing";
    this.announce();
    return {
      prompt: null,
      filesNote: "files put back",
      undoable: this.undoable(),
      redoable: this.redoable(),
    };
  }

  private async stageFiles(checkpoint: string | undefined): Promise<StagedFiles> {
    const { checkpoints } = this.seams;
    if (checkpoints === undefined || checkpoint === undefined) return untouchedFiles;
    const left = await checkpoints.snapshot();
    await checkpoints.restoreTo(checkpoint);
    return { note: "files put back", restore: () => checkpoints.restoreTo(left) };
  }

  private undoable(): boolean {
    return lastPromptOf(this.store) !== undefined || this.seams.checkpoints?.canUndo() === true;
  }

  private redoable(): boolean {
    return this.staged !== undefined || this.seams.checkpoints?.canRedo() === true;
  }

  private swap(next: Agent): void {
    const previous = this.agent;
    this.ledger.retire(previous);
    next.setThinking(previous.thinking());
    next.setEffort(previous.effort());
    this.agent = next;
    this.persisted = next.history().length;
    next.adoptQueue(previous);
  }

  private announce(): void {
    const { model, thinking, effort, title } = this.summary();
    const state: SessionState = {
      ...(model !== undefined && { model }),
      thinking: thinking ?? false,
      ...(effort !== undefined && { effort }),
      title,
      leafId: this.store.leafId(),
      undoable: this.undoable(),
      redoable: this.redoable(),
    };
    this.seams.log.record(this.id, "session.state", state);
  }

  private async persist(): Promise<void> {
    const before = this.persisted;
    this.persisted = await persistNewMessages(
      this.store,
      this.agent.history(),
      this.persisted,
      this.seams.checkpoints,
    );
    if (this.persisted > before) {
      this.seams.log.record(this.id, "session.tree", treeChange(this.store, "entry"));
    }
  }
}

function adoptSessionSettings(agent: Agent, store: SessionStore): void {
  const thinking = thinkingSwitchOf(store);
  if (thinking !== undefined) agent.setThinking(thinking);
  const effort = effortOf(store);
  if (effort !== undefined) agent.setEffort(effort);
}

function lastPromptOf(store: SessionStore): MessageEntry | undefined {
  return store
    .activePath()
    .findLast(
      (entry): entry is MessageEntry => entry.type === "message" && entry.message.role === "user",
    );
}

function publicSummary(summary: StoredSummary): SessionSummary {
  return {
    id: summary.id,
    title: summary.title,
    createdAt: summary.createdAt,
    lastActivityAt: summary.lastActivityAt,
    messageCount: summary.messageCount,
    ...(summary.model !== undefined && { model: summary.model }),
    ...(summary.thinking !== undefined && { thinking: summary.thinking }),
    ...(summary.effort !== undefined && { effort: summary.effort }),
    ...(summary.costNanos !== undefined && { costNanos: summary.costNanos }),
    ...(summary.arc !== undefined && { arc: summary.arc }),
    ...(summary.bot !== undefined && { bot: summary.bot }),
  };
}

function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
