import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Agent,
  type JournalTap,
  type PermissionResolver,
  type Provider,
  SessionStore,
  ShellSession,
  type ToolGuard,
  tapJournal,
} from "@keywork/engine";
import {
  EventLog,
  issueToken,
  listen,
  removeServerTicket,
  type SessionDetail,
  type SessionHost,
  type SessionSummary,
  writeServerTicket,
} from "@keywork/server";
import type {
  KeyworkConfig,
  LspConfig,
  McpServerConfig,
  ModelCapabilitiesConfig,
  PromptsConfig,
} from "@keywork/shared";
import { persistNewMessages } from "./chat.ts";
import {
  type AgentComposition,
  type Composition,
  composeAgents,
  composeWorkspace,
} from "./compose.ts";
import { defaultSessionDir, keyworkHome } from "./paths.ts";
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
  signal: AbortSignal;
  print: (line: string) => void;
  printError: (line: string) => void;
}

export interface HostOptions {
  cwd: string;
  projectTrusted: boolean;
  provider: Provider;
  permissions: PermissionResolver;
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

export function serverTicketFile(): string {
  return join(keyworkHome(), "server.json");
}

export async function serve(options: ServeOptions): Promise<number> {
  const log = new EventLog();
  const host = fileSessionHost({ ...options, log, notice: options.printError });
  const token = issueToken();
  const ticketFile = options.ticketFile ?? serverTicketFile();
  let server: Awaited<ReturnType<typeof listen>>;
  try {
    server = await listen({ token, host, log, version: keyworkVersion, port: options.port });
  } catch (cause) {
    options.printError(`keywork serve: ${cause instanceof Error ? cause.message : String(cause)}`);
    await host.close();
    return 1;
  }
  writeServerTicket(ticketFile, { url: server.url, token });
  options.print(`listening on ${server.url}`);
  options.print(`token ${token}`);
  options.print(`ticket ${ticketFile}`);
  await untilAborted(options.signal);
  await server.close();
  removeServerTicket(ticketFile);
  return 0;
}

export function fileSessionHost(options: HostOptions & { log: EventLog }): SessionHost {
  const sessions = new LiveSessions(options);
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
    close: () => sessions.close(),
  };
}

const headlessGuard: ToolGuard = { confirm: async () => false, gate: "headless" };

class LiveSessions {
  private readonly live = new Map<string, LiveSession>();
  private readonly sessionDir: string;
  private workspace: Promise<{ composition: Composition; agents: AgentComposition }> | undefined;

  constructor(private readonly options: HostOptions & { log: EventLog }) {
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
    if (live !== undefined) return live.detail();
    const store = await this.stored(id);
    if (store === undefined) return undefined;
    return {
      ...publicSummary(await summarize(store)),
      cwd: store.header.cwd,
      live: false,
      messages: store.messages(),
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
      guard: headlessGuard,
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

  detail(): SessionDetail {
    return {
      ...this.summary(),
      cwd: this.store.header.cwd,
      live: true,
      messages: this.agent.history(),
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
