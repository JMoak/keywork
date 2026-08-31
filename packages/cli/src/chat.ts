import {
  type Agent,
  type AgentDefinition,
  type Checkpoints,
  type CommandRuntime,
  compactNow,
  contextBudgetFor,
  declaredContextWindow,
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
import { type McpServerConfig, type PromptsConfig, toError } from "@keywork/shared";
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
import { sweepOnClose } from "./memory.ts";
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
  agent: async (repl, args) => switchAgent(repl, args),
  steer: (repl, args) => submitPrompt(repl, args, "steer"),
  queue: (repl, args) => submitPrompt(repl, args, "queue"),
};

const builtinCommandNames: readonly string[] = Object.keys(builtinCommands);

const exitWords = new Set(["exit", "quit"]);

class Repl {
  agent: Agent;
  activeAgent: AgentDefinition | undefined;
  persisted: number;
  private builtWith: AgentDefinition | undefined;
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
    this.agent = this.buildAgent(undefined, seeded);
    this.persisted = seeded.length;
  }

  get checkpoints(): Checkpoints | undefined {
    return this.composition.checkpoints;
  }

  get extensions(): WorkspaceExtensions {
    return this.composition.extensions;
  }

  buildAgent(definition: AgentDefinition | undefined, history: readonly Message[]): Agent {
    const agent = this.agents.build({
      provider: this.options.provider,
      guard: this.guard,
      definition,
      history,
      sessionId: this.store.header.id,
    });
    wireStreamingOutput(agent, this.io);
    agent.settleTurnsWith(() => this.afterTurn(agent));
    return agent;
  }

  adopt(definition: AgentDefinition | undefined, history: readonly Message[]): void {
    const previous = this.agent;
    this.agent = this.buildAgent(definition, history);
    this.builtWith = definition;
    this.persisted = history.length;
    this.agent.adoptQueue(previous);
  }

  rebuild(history: readonly Message[]): void {
    this.adopt(this.activeAgent, history);
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
      if (this.builtWith !== this.activeAgent || settlement.history !== undefined) {
        this.rebuild(settlement.history ?? agent.history());
      }
    } catch (cause) {
      this.io.printError(`settling the turn failed: ${toError(cause).message}`);
    }
  }

  async close(): Promise<void> {
    await this.composition.mcp?.stop();
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
    reportCheckpointsUnavailable: (message) => io.print(`can't undo: ${message}`),
    ...(options.userRoot !== undefined && { userRoot: options.userRoot }),
    ...(options.checkpointsGitDir !== undefined && {
      checkpointsGitDir: options.checkpointsGitDir,
    }),
  });
  reportExtensionFailures(composition.extensions, io);
  const guard = mutationGuard(io, composition.checkpoints);
  const repl = new Repl(
    options,
    io,
    opened.store,
    composition,
    composeAgents(composition, { permissions: options.permissions }),
    guard,
    commandRuntime(options.cwd, guard),
    opened.seeded,
  );
  replaySession(opened.store, repl.agent.bus);
  greet(repl, opened.seeded.length);
  return repl;
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
  const definition = repl.extensions.agents.find((agent) => agent.name === invoked.command.agent);
  await submitPrompt(repl, prompt, "queue", definition);
}

async function submitPrompt(
  repl: Repl,
  prompt: string,
  behavior: SendBehavior,
  definition: AgentDefinition | undefined = repl.activeAgent,
): Promise<void> {
  const text = prompt.trim();
  if (text === "") {
    repl.io.print(`usage: /${behavior} <prompt>`);
    return;
  }
  if (definition !== repl.activeAgent) {
    await repl.drained();
    repl.adopt(definition, repl.agent.history());
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

function switchAgent(repl: Repl, name: string): void {
  const { agents } = repl.extensions;
  if (name === "") {
    listAgents(agents, repl.io);
    return;
  }
  const definition = agents.find((candidate) => candidate.name === name);
  if (name !== "none" && definition === undefined) {
    listAgents(agents, repl.io, `unknown agent "${name}"`);
    return;
  }
  repl.io.print(definition === undefined ? "back to the default agent" : `agent → ${name}`);
  repl.activeAgent = definition;
  repl.rebuild(repl.agent.history());
}

function listAgents(agents: readonly AgentDefinition[], io: ChatIo, prefix?: string): void {
  if (agents.length === 0) {
    io.print("no agents yet, add one at .keywork/agents/<name>.md");
    return;
  }
  if (prefix !== undefined) io.print(prefix);
  io.print("/agent <name> to switch · /agent none to clear");
  for (const agent of agents) {
    io.print(`  ${agent.name}${agent.description === undefined ? "" : ` · ${agent.description}`}`);
  }
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
  agent.bus.on("turn.delta", ({ delta, replay }) => {
    if (replay !== true && delta.type === "text") io.write(delta.text);
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
    if (replay !== true) io.print("");
  });
  agent.bus.on("turn.interrupted", () => io.print("\n(interrupted)"));
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
  if (extensions.agents.length > 0) {
    io.print(`agents (/agent <name>): ${extensions.agents.map((agent) => agent.name).join(", ")}`);
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
