import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Agent,
  type JournalTap,
  type PermissionResolver,
  type Provider,
  SessionStore,
  ShellSession,
  tapJournal,
} from "@keywork/engine";
import {
  AskQueue,
  EventLog,
  issueToken,
  listen,
  readServerTicket,
  removeServerTicket,
  type ServerTicket,
  type SessionDetail,
  type SessionHost,
  type SessionSummary,
  type WorkspaceInfo,
  writeServerTicket,
} from "@keywork/server";
import {
  type KeyworkConfig,
  type LspConfig,
  type McpServerConfig,
  type ModelCapabilitiesConfig,
  type PromptsConfig,
  resolveAnchor,
} from "@keywork/shared";
import { persistNewMessages } from "./chat.ts";
import {
  type AgentComposition,
  type Composition,
  composeAgents,
  composeWorkspace,
} from "./compose.ts";
import { defaultSessionDir, keyworkHome, workspaceIdentity } from "./paths.ts";
import {
  findSession,
  listSessions,
  newSessionFileName,
  type SessionSummary as StoredSummary,
  summarize,
} from "./sessions/store.ts";
import { keyworkVersion } from "./version.ts";

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
  askTimeoutMs?: number | undefined;
  workspaceSlug?: string | undefined;
  sessionDir?: string | undefined;
  userRoot?: string | undefined;
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
  const asks = new AskQueue({
    ...(options.askTimeoutMs !== undefined && { timeoutMs: options.askTimeoutMs }),
  });
  const sessions = new LiveSessions(options, asks);
  return {
    list: () => sessions.list(),
    read: (id) => sessions.read(id),
    create: () => sessions.create(),
    prompt: async (id, text) => {
      const live = await sessions.open(id);
      if (live === undefined) return "missing";
      live.run(text);
      return "accepted";
    },
    abort: async (id) => {
      const live = sessions.liveOnly(id);
      if (live !== undefined) return live.interrupt();
      return (await sessions.stored(id)) === undefined ? "missing" : "idle";
    },
    asks: async () => asks.list(),
    answerAsk: async (callId, verdict) => asks.answer(callId, verdict),
    close: async () => {
      asks.close();
      await sessions.close();
    },
  };
}

class LiveSessions {
  private readonly live = new Map<string, LiveSession>();
  private readonly sessionDir: string;
  private workspace: Promise<{ composition: Composition; agents: AgentComposition }> | undefined;

  constructor(
    private readonly options: HostOptions & { log: EventLog },
    private readonly asks: AskQueue,
  ) {
    this.sessionDir = options.sessionDir ?? defaultSessionDir(options.cwd, options.workspaceSlug);
  }

  async list(): Promise<SessionSummary[]> {
    const { sessions } = await listSessions(this.sessionDir);
    const listed = sessions.map(publicSummary);
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

  async close(): Promise<void> {
    for (const live of this.live.values()) await live.close();
    this.live.clear();
    if (this.workspace === undefined) return;
    const { composition } = await this.workspace;
    await composition.languagePort?.dispose();
    await composition.mcp?.stop();
  }

  private async adopt(store: SessionStore): Promise<LiveSession> {
    const { agents } = await this.composed();
    const shell = new ShellSession(this.options.cwd);
    const agent = agents.build({
      provider: this.options.provider,
      guard: this.asks.guardFor(store.header.id),
      shell,
      history: store.messages(),
      sessionId: store.header.id,
    });
    const live = new LiveSession(store, agent, shell, this.options.log);
    this.live.set(store.header.id, live);
    return live;
  }

  private composed(): Promise<{ composition: Composition; agents: AgentComposition }> {
    this.workspace ??= this.compose();
    return this.workspace;
  }

  private async compose(): Promise<{ composition: Composition; agents: AgentComposition }> {
    const { options } = this;
    const composition = await composeWorkspace({
      cwd: options.cwd,
      projectTrusted: options.projectTrusted,
      workspaceSlug: options.workspaceSlug,
      prompts: options.prompts,
      mcpServers: options.mcpServers,
      repoMap: options.repoMap,
      models: options.models,
      checkpoints: "off",
      lsp: options.lsp,
      notice: (text) => options.notice?.(`keywork serve: ${text}`),
      userRoot: options.userRoot ?? homedir(),
    });
    for (const failure of composition.extensions.failures) {
      options.notice?.(`keywork serve: skipped extension ${failure.file} · ${failure.reason}`);
    }
    const agents = composeAgents(composition, {
      permissions: options.permissions,
      thinking: options.thinking === "on",
    });
    return { composition, agents };
  }
}

class LiveSession {
  readonly id: string;
  private readonly journal: JournalTap;
  private readonly detach: () => void;
  private persisted: number;
  private settled: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: SessionStore,
    private readonly agent: Agent,
    private readonly shell: ShellSession,
    log: EventLog,
  ) {
    this.id = store.header.id;
    this.persisted = agent.history().length;
    this.journal = tapJournal(agent.bus, store);
    this.detach = log.attach(agent.bus, this.id);
  }

  run(text: string): void {
    this.settled = this.agent
      .send(text)
      .catch(() => undefined)
      .then(() => this.persist());
  }

  interrupt(): "aborted" | "idle" {
    if (!this.agent.busy()) return "idle";
    this.agent.interrupt();
    return "aborted";
  }

  summary(): SessionSummary {
    const stats = this.store.stats();
    return {
      id: this.id,
      title: this.store.name() ?? "(untitled session)",
      createdAt: this.store.header.timestamp,
      lastActivityAt: stats.lastActivityAt,
      messageCount: this.agent.history().length,
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
    this.detach();
    await this.shell.close();
  }

  private async persist(): Promise<void> {
    this.persisted = await persistNewMessages(this.store, this.agent.history(), this.persisted);
  }
}

function publicSummary(summary: StoredSummary): SessionSummary {
  return {
    id: summary.id,
    title: summary.title,
    createdAt: summary.createdAt,
    lastActivityAt: summary.lastActivityAt,
    messageCount: summary.messageCount,
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
