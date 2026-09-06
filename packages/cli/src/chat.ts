import { homedir } from "node:os";
import {
  type Agent,
  type BotDefinition,
  type Checkpoints,
  type CommandRuntime,
  compactNow,
  contextBudgetFor,
  declaredContextWindow,
  gatherReturnDelta,
  type MemoryFlush,
  type Message,
  type PermissionResolver,
  type Provider,
  renderCommand,
  replaySession,
  type SendBehavior,
  type SessionStore,
  settleTurn,
  type ToolGuard,
  type TurnSettlement,
} from "@keywork/engine";
import {
  type KeyworkConfig,
  type LspConfig,
  type McpServerConfig,
  type ModelCapabilitiesConfig,
  type PromptsConfig,
  toError,
} from "@keywork/shared";
import { botMemory } from "./bot-memory.ts";
import {
  commandRuntime,
  parseSlashLine,
  resolveSlashCommand,
  slashCompleter,
  type WorkspaceExtensions,
} from "./commands.ts";
import {
  type AgentComposition,
  type Composition,
  composeAgents,
  composeWorkspace,
} from "./compose.ts";
import { citationTrail, sweepOnClose } from "./memory.ts";
import { defaultSessionDir } from "./paths.ts";
import { type PresetPort, presetCommand } from "./presets.ts";
import { openOrResumeSession } from "./sessions/store.ts";
import {
  type KeyPress,
  type LineReadOptions,
  processStreams,
  type TerminalStreams,
  terminalInput,
} from "./terminal-input.ts";
import { compactJson, firstLine } from "./text.ts";

export interface ChatOptions {
  cwd: string;
  provider: Provider;
  label: string;
  workspaceSlug?: string;
  sessionDir?: string;
  resume?: boolean;
  resumeId?: string;
  projectTrusted?: boolean;
  prompts?: PromptsConfig;
  permissions?: PermissionResolver;
  presets?: PresetPort;
  mcpServers?: Record<string, McpServerConfig>;
  repoMap?: "auto" | "off";
  lsp?: LspConfig;
  models?: ModelCapabilitiesConfig;
  thinking?: KeyworkConfig["thinking"];
  userRoot?: string;
  checkpointsGitDir?: string;
}

export interface ChatIo {
  readonly interactive: boolean;
  readLine(prompt: string, options?: LineReadOptions): Promise<string | undefined>;
  readKey(): Promise<KeyPress | undefined>;
  onKey(listener: (key: KeyPress) => void): () => void;
  confirm(question: string): Promise<boolean>;
  close(): void;
  print(line: string): void;
  printError(line: string): void;
  write(text: string): void;
}

export async function chat(options: ChatOptions, io: ChatIo = terminalChatIo()): Promise<void> {
  try {
    const repl = await openRepl(options, io);
    if (repl === undefined) return;
    try {
      await runRepl(repl);
    } finally {
      await repl.close();
    }
  } finally {
    io.close();
  }
}

export function terminalChatIo(streams: TerminalStreams = processStreams()): ChatIo {
  return {
    ...terminalInput(streams),
    print: (line) => console.log(line),
    printError: (line) => console.error(line),
    write: (text) => streams.output.write(text),
  };
}

export async function persistNewMessages(
  store: SessionStore,
  history: readonly Message[],
  persisted: number,
  checkpoints?: Pick<Checkpoints, "takeTurnTag">,
): Promise<number> {
  for (const message of history.slice(persisted)) {
    const checkpoint = message.role === "user" ? checkpoints?.takeTurnTag() : undefined;
    await store.append(message, undefined, checkpoint);
  }
  return history.length;
}

type SlashHandler = (repl: Repl, args: string) => Promise<void>;

const promptBehaviors: Readonly<Record<string, SendBehavior>> = {
  queue: "queue",
  steer: "steer",
};

const builtinCommands: Readonly<Record<string, SlashHandler>> = {
  session: async (repl) => printSessionInfo(repl),
  undo: (repl) => timeTravel(repl, "undo"),
  redo: (repl) => timeTravel(repl, "redo"),
  label: (repl, args) => labelLeaf(repl, args),
  preset: (repl, args) =>
    presetCommand(args, repl.options.presets, repl.io.print, (question) =>
      repl.io.confirm(question),
    ),
  compact: (repl, args) => compactSession(repl, args),
  bot: (repl, args) => switchBot(repl, args),
  steer: (repl, args) => submitPrompt(repl, args, "steer"),
  queue: (repl, args) => submitPrompt(repl, args, "queue"),
};

const builtinCommandNames: readonly string[] = Object.keys(builtinCommands);

const exitWords = new Set(["exit", "quit"]);

class Repl {
  agent: Agent;
  activeBot: BotDefinition | undefined;
  persisted: number;
  private builtWith: BotDefinition | undefined;
  private turns: Promise<unknown> = Promise.resolve();

  constructor(
    readonly options: ChatOptions,
    readonly io: ChatIo,
    readonly store: SessionStore,
    readonly composition: Composition,
    readonly agents: AgentComposition,
    readonly guard: ToolGuard,
    readonly runtime: CommandRuntime,
    seeded: readonly Message[],
  ) {
    this.activeBot = this.botNamed(store.botBinding());
    this.builtWith = this.activeBot;
    this.agent = this.buildAgent(this.activeBot, seeded);
    this.persisted = seeded.length;
  }

  botNamed(name: string | undefined): BotDefinition | undefined {
    return this.extensions.bots.find((bot) => bot.name === name);
  }

  get checkpoints(): Checkpoints | undefined {
    return this.composition.checkpoints;
  }

  get extensions(): WorkspaceExtensions {
    return this.composition.extensions;
  }

  buildAgent(bot: BotDefinition | undefined, history: readonly Message[]): Agent {
    const agent = this.agents.build({
      provider: this.options.provider,
      guard: this.guard,
      bot,
      history,
      sessionId: this.store.header.id,
    });
    wireStreamingOutput(agent, this.io);
    agent.settleTurnsWith(() => this.afterTurn(agent));
    return agent;
  }

  adopt(bot: BotDefinition | undefined, history: readonly Message[]): void {
    const previous = this.agent;
    this.agent = this.buildAgent(bot, history);
    this.builtWith = bot;
    this.persisted = history.length;
    this.agent.adoptQueue(previous);
  }

  rebuild(history: readonly Message[]): void {
    this.adopt(this.activeBot, history);
  }

  dispatch(prompt: string, behavior: SendBehavior): Promise<void> {
    if (this.agent.busy()) this.io.print(behavior === "steer" ? "  · steering" : "  · queued");
    const turn = this.agent.send(prompt, { behavior }).then(
      () => undefined,
      (cause: unknown) => this.io.printError(`\nerror: ${toError(cause).message}`),
    );
    this.turns = this.turns.then(() => turn);
    return turn;
  }

  drained(): Promise<void> {
    return this.turns.then(() => undefined);
  }

  interrupt(): void {
    this.agent.interrupt();
  }

  flush(): MemoryFlush | undefined {
    return this.agents.flushFor(this.store.header.id, this.options.provider);
  }

  private async afterTurn(agent: Agent): Promise<void> {
    if (agent !== this.agent) return;
    try {
      printUsageLine(agent, this.io);
      this.persisted = await persistNewMessages(
        this.store,
        agent.history(),
        this.persisted,
        this.checkpoints,
      );
      const settlement = await settleTurn({
        store: this.store,
        provider: agent.provider,
        history: agent.history(),
        budget: contextBudgetFor(declaredContextWindow(agent.provider)),
        flush: this.flush(),
      });
      reportSettlement(settlement, this.io);
      if (this.builtWith !== this.activeBot || settlement.history !== undefined) {
        this.rebuild(settlement.history ?? agent.history());
      }
    } catch (cause) {
      this.io.printError(`settling the turn failed: ${toError(cause).message}`);
    }
  }

  async close(): Promise<void> {
    await this.composition.mcp?.stop();
    await this.composition.languagePort?.dispose();
    await sweepOnClose(this.composition.memory()).catch((cause: unknown) => {
      this.io.printError(`memory sweep failed: ${toError(cause).message}`);
    });
  }
}

async function openRepl(options: ChatOptions, io: ChatIo): Promise<Repl | undefined> {
  const dir = options.sessionDir ?? defaultSessionDir(options.cwd, options.workspaceSlug);
  const opened = await openOrResumeSession(dir, options.cwd, {
    continueLatest: options.resume ?? false,
    ...(options.resumeId !== undefined && { resumeId: options.resumeId }),
  }).catch((cause: unknown) => {
    io.printError(toError(cause).message);
    return undefined;
  });
  if (opened === undefined) return undefined;
  const composition = await composeWorkspace({
    cwd: options.cwd,
    projectTrusted: options.projectTrusted === true,
    workspaceSlug: options.workspaceSlug,
    prompts: options.prompts,
    mcpServers: options.mcpServers,
    repoMap: options.repoMap,
    models: options.models,
    reportCheckpointsUnavailable: (message) => io.print(`can't undo: ${message}`),
    lsp: options.lsp,
    notice: (text) => io.print(text),
    ...(options.userRoot !== undefined && { userRoot: options.userRoot }),
    ...(options.checkpointsGitDir !== undefined && {
      checkpointsGitDir: options.checkpointsGitDir,
    }),
  });
  reportExtensionFailures(composition.extensions, io);
  const guard = mutationGuard(io, composition.checkpoints);
  const citations = citationTrail(composition.memory, () => composition.bootstrap);
  citations.forSession(opened.store.header.id);
  const bots = botMemory({
    cwd: options.cwd,
    projectTrusted: options.projectTrusted === true,
    workspaceSlug: options.workspaceSlug,
    userRoot: options.userRoot ?? homedir(),
    memory: composition.memory,
    roster: composition.extensions.bots,
    bindingOf: () => opened.store.botBinding(),
  });
  await bots.prepare();
  const repl = new Repl(
    options,
    io,
    opened.store,
    composition,
    composeAgents(composition, {
      permissions: options.permissions,
      bots,
      citations,
      thinking: options.thinking === "on",
    }),
    guard,
    commandRuntime(options.cwd, guard),
    opened.seeded,
  );
  replaySession(opened.store, repl.agent.bus);
  greet(repl, opened.seeded.length);
  if (opened.seeded.length > 0) await printReturnDelta(repl);
  return repl;
}

async function printReturnDelta(repl: Repl): Promise<void> {
  const memory = repl.composition.memory();
  if (memory === undefined) return;
  const since = repl.store.stats().lastActivityAt;
  const lines = await gatherReturnDelta({ since, workspace: memory.store }).catch(() => []);
  if (lines.length > 0) repl.io.print(`since you were here: ${lines.join(" · ")}`);
}

async function runRepl(repl: Repl): Promise<void> {
  const complete = slashCompleter([
    ...builtinCommandNames,
    ...repl.extensions.commands.map((command) => command.name),
  ]);
  const stopListening = repl.io.onKey((key) => {
    if (key.name === "escape" || (key.ctrl && key.name === "c")) repl.interrupt();
  });
  try {
    while (true) {
      const line = (await repl.io.readLine("\n› ", { complete }))?.trim();
      if (line === undefined || exitWords.has(line)) break;
      if (line !== "") await handleLine(repl, line);
    }
    await repl.drained();
  } finally {
    stopListening();
  }
}

async function handleLine(repl: Repl, line: string): Promise<void> {
  const slash = parseSlashLine(line);
  if (slash === undefined) return submitPrompt(repl, line, "queue");
  if (Object.hasOwn(builtinCommands, slash.name)) {
    if (promptBehaviors[slash.name] === undefined) await repl.drained();
    return builtinCommands[slash.name]?.(repl, slash.args);
  }
  const invoked = resolveSlashCommand(repl.extensions.commands, line);
  if (invoked === undefined) {
    repl.io.printError(`unknown command /${slash.name} · ${knownCommandsLine(repl)}`);
    return;
  }
  const prompt = await renderCommand(invoked.command.template, invoked.args, repl.runtime).catch(
    (cause: unknown) => {
      repl.io.printError(`/${invoked.command.name} failed: ${toError(cause).message}`);
      return undefined;
    },
  );
  if (prompt === undefined) return;
  await submitPrompt(repl, prompt, "queue", repl.botNamed(invoked.command.bot));
}

async function submitPrompt(
  repl: Repl,
  prompt: string,
  behavior: SendBehavior,
  bot: BotDefinition | undefined = repl.activeBot,
): Promise<void> {
  const text = prompt.trim();
  if (text === "") {
    repl.io.print(`usage: /${behavior} <prompt>`);
    return;
  }
  if (bot !== repl.activeBot) {
    await repl.drained();
    repl.adopt(bot, repl.agent.history());
  }
  void repl.dispatch(text, behavior);
}

async function compactSession(repl: Repl, instructions: string): Promise<void> {
  const settlement = await compactNow({
    store: repl.store,
    provider: repl.options.provider,
    budget: contextBudgetFor(declaredContextWindow(repl.options.provider)),
    instructions,
    flush: repl.flush(),
  });
  reportSettlement(settlement, repl.io);
  if (settlement.history !== undefined) repl.rebuild(settlement.history);
}

async function switchBot(repl: Repl, name: string): Promise<void> {
  const { bots } = repl.extensions;
  if (name === "") {
    listBots(bots, repl.io);
    return;
  }
  const bot = repl.botNamed(name);
  if (name !== "none" && bot === undefined) {
    listBots(bots, repl.io, `no bot named ${name}`);
    return;
  }
  repl.io.print(bot === undefined ? "bot released" : `bot → ${botLabel(bot)}`);
  repl.activeBot = bot;
  await repl.store.appendBotBinding(bot?.name);
  repl.rebuild(repl.agent.history());
}

function listBots(bots: readonly BotDefinition[], io: ChatIo, prefix?: string): void {
  if (bots.length === 0) {
    io.print("no bots yet, add one at .keywork/bots/<slug>/bot.md");
    return;
  }
  if (prefix !== undefined) io.print(prefix);
  io.print("/bot <slug> to switch · /bot none to release");
  for (const bot of bots) {
    io.print(`  ${botLabel(bot)}${bot.description === undefined ? "" : ` · ${bot.description}`}`);
  }
}

function botLabel(bot: BotDefinition): string {
  return `${bot.sigil} ${bot.name}`;
}

async function labelLeaf(repl: Repl, name: string): Promise<void> {
  const leaf = repl.store.leafId();
  if (leaf === null) {
    repl.io.print("nothing to label yet");
    return;
  }
  if (name === "") {
    repl.io.print("usage: /label <name>");
    return;
  }
  await repl.store.setLabel(leaf, name);
  repl.io.print(`labeled ${leaf.slice(0, 8)} as "${name}"`);
}

async function timeTravel(repl: Repl, direction: "undo" | "redo"): Promise<void> {
  const { checkpoints, io } = repl;
  if (checkpoints === undefined) {
    io.print("undo unavailable in this session");
    return;
  }
  const moved = direction === "undo" ? await checkpoints.undo() : await checkpoints.redo();
  if (moved) io.print(direction === "undo" ? "files put back" : "files redone");
  else io.print(direction === "undo" ? "nothing to undo" : "nothing to redo");
}

function mutationGuard(io: ChatIo, checkpoints: Checkpoints | undefined): ToolGuard {
  let alwaysAllow = false;
  return {
    gate: io.interactive ? "user" : "headless",
    confirm: async (call) => {
      if (alwaysAllow) return true;
      if (!io.interactive) {
        io.printError(`  ? ${call.name} needs approval and there is no terminal to ask · refused`);
        return false;
      }
      io.print(
        `\n  ? ${call.name} ${compactJson(call.arguments, 80)}  [y] allow  [a] always  [n] deny`,
      );
      const answer = await nextAnswer(io);
      alwaysAllow = answer === "always";
      return answer !== "deny";
    },
    ...(checkpoints !== undefined && { beforeMutation: () => checkpoints.capture() }),
  };
}

type Answer = "allow" | "always" | "deny";

async function nextAnswer(io: ChatIo): Promise<Answer> {
  while (true) {
    const key = await io.readKey();
    if (key === undefined) return "deny";
    const answer = answerFor(key);
    if (answer !== undefined) return answer;
  }
}

function answerFor(key: KeyPress): Answer | undefined {
  if (key.ctrl) return key.name === "c" ? "deny" : undefined;
  if (key.name === "y" || key.name === "return") return "allow";
  if (key.name === "a") return "always";
  if (key.name === "n" || key.name === "escape") return "deny";
  return undefined;
}

function wireStreamingOutput(agent: Agent, io: ChatIo): void {
  const thinking = thinkingStream(io);
  agent.bus.on("turn.delta", ({ delta, replay }) => {
    if (replay === true) return;
    if (delta.type === "visible-thinking") thinking.write(delta.text);
    if (delta.type === "text") {
      thinking.close();
      io.write(delta.text);
    }
  });
  agent.bus.on("tool.output", ({ chunk, replay }) => {
    if (replay !== true) io.write(chunk);
  });
  agent.bus.on("tool.started", ({ call, replay }) => {
    if (replay !== true) io.print(`\n· ${call.name} ${compactJson(call.arguments, 80)}`);
  });
  agent.bus.on("tool.finished", ({ output, isError, replay }) => {
    if (replay !== true) io.print(`  ${isError ? "✗" : "✓"} ${firstLine(output, 100)}`);
  });
  agent.bus.on("turn.completed", ({ replay }) => {
    if (replay === true) return;
    thinking.close();
    io.print("");
  });
  agent.bus.on("turn.interrupted", () => io.print("\n(interrupted)"));
}

interface ThinkingStream {
  write(text: string): void;
  close(): void;
}

function thinkingStream(io: ChatIo): ThinkingStream {
  let open = false;
  return {
    write: (text) => {
      open = true;
      io.write(dimmed(text));
    },
    close: () => {
      if (open) io.write("\n");
      open = false;
    },
  };
}

function dimmed(text: string): string {
  return `\u001b[2m${text}\u001b[22m`;
}

function greet(repl: Repl, seededCount: number): void {
  const { io, options, store, extensions } = repl;
  io.print(`keywork · ${options.label} · ${options.cwd}`);
  io.print(`session → ${store.file}`);
  if (seededCount > 0) io.print(`resumed ${seededCount} messages`);
  io.print(
    `Type to start · a line typed mid-turn queues · /steer <text> interrupts and sends now · Esc stops a turn · "exit" quits · /session stats · /undo takes back the last change · /compact shrinks old context · /label <name> bookmarks here · /preset switches permissions`,
  );
  if (extensions.commands.length > 0) {
    io.print(`commands: ${extensions.commands.map((command) => `/${command.name}`).join(" ")}`);
  }
  if (extensions.bots.length > 0) {
    io.print(`bots (/bot <slug>): ${extensions.bots.map(botLabel).join(", ")}`);
  }
  if (extensions.skills.length > 0) {
    io.print(`skills: ${extensions.skills.map((skill) => skill.name).join(", ")}`);
  }
}

function knownCommandsLine(repl: Repl): string {
  return [...builtinCommandNames, ...repl.extensions.commands.map((command) => command.name)]
    .map((name) => `/${name}`)
    .join(" ");
}

function reportExtensionFailures(extensions: WorkspaceExtensions, io: ChatIo): void {
  for (const failure of extensions.failures) {
    io.printError(`skipped extension ${failure.file}: ${failure.reason}`);
  }
}

function reportSettlement(settlement: TurnSettlement, io: ChatIo): void {
  for (const notice of settlement.notices) io.print(`  · ${notice}`);
}

function printUsageLine(agent: Agent, io: ChatIo): void {
  const { inputTokens, outputTokens } = agent.usage();
  io.print(`  · session ${inputTokens} in / ${outputTokens} out`);
}

function printSessionInfo(repl: Repl): void {
  const { store, agent, io } = repl;
  const stats = store.stats();
  const { inputTokens, outputTokens } = agent.usage();
  io.print(`file      ${store.file}`);
  io.print(`id        ${store.header.id}`);
  io.print(
    `entries   ${stats.entries} (${stats.messages} messages, ${stats.branchPoints} branch points, ${stats.labels} labels, ${stats.compactions} compactions)`,
  );
  io.print(`tokens    ${inputTokens} in / ${outputTokens} out this run`);
}
