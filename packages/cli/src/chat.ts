import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import {
  type Agent,
  type AgentDefinition,
  type Checkpoints,
  type CommandRuntime,
  compactSession,
  type Message,
  type PermissionResolver,
  type Provider,
  renderCommand,
  replaySession,
  type SessionStore,
  type ToolGuard,
} from "@keywork/engine";
import type { McpServerConfig, PromptsConfig } from "@keywork/shared";
import {
  commandRuntime,
  resolveSlashCommand,
  slashCompleter,
  type WorkspaceExtensions,
} from "./commands.ts";
import { composeAgents, composeWorkspace } from "./compose.ts";
import { flushAfterTurn, sweepOnClose } from "./memory.ts";
import { defaultSessionDir } from "./paths.ts";
import { type PresetPort, presetCommand } from "./presets.ts";
import { openOrResumeSession } from "./sessions.ts";

export interface ChatOptions {
  cwd: string;
  provider: Provider;
  label: string;
  sessionDir?: string;
  resume?: boolean;
  resumeId?: string;
  projectTrusted?: boolean;
  prompts?: PromptsConfig;
  modelId?: string;
  permissions?: PermissionResolver;
  presets?: PresetPort;
  mcpServers?: Record<string, McpServerConfig>;
}

export async function chat(options: ChatOptions): Promise<void> {
  const dir = options.sessionDir ?? defaultSessionDir(options.cwd);
  const opened = await tryOpenSession(dir, options);
  if (opened === undefined) return;
  const { store, seeded } = opened;
  const composition = await composeWorkspace({
    cwd: options.cwd,
    projectTrusted: options.projectTrusted === true,
    prompts: options.prompts,
    mcpServers: options.mcpServers,
    reportCheckpointsUnavailable: (message) => console.log(`can't undo: ${message}`),
  });
  const { checkpoints, extensions, mcp, memory } = composition;
  const agents = composeAgents(composition, { permissions: options.permissions });
  const flush = agents.flushFor(store.header.id, options.provider);
  reportExtensionFailures(extensions);
  const guard = mutationGuard(checkpoints);
  const runtime = commandRuntime(options.cwd, guard);

  let activeAgent: AgentDefinition | undefined;
  const buildAgentFor = (
    definition: AgentDefinition | undefined,
    history: readonly Message[],
  ): Agent => {
    const agent = agents.build({
      provider: options.provider,
      guard,
      definition,
      history,
      sessionId: store.header.id,
    });
    wireStreamingOutput(agent);
    return agent;
  };
  const buildAgent = (history: readonly Message[]): Agent => buildAgentFor(activeAgent, history);
  let agent = buildAgent(seeded);
  replaySession(store, agent.bus);
  greet(options, store, seeded, extensions);

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: slashCompleter([
      ...builtinCommandNames,
      ...extensions.commands.map((command) => command.name),
    ]),
  });
  let persisted = seeded.length;
  try {
    while (true) {
      const line = (await readline.question("\n› ")).trim();
      if (line === "") continue;
      if (line === "exit" || line === "quit") break;
      if (line === "/session") {
        printSessionInfo(agent, store);
        continue;
      }
      if (line === "/undo" || line === "/redo") {
        await timeTravel(checkpoints, line);
        continue;
      }
      if (line.startsWith("/label")) {
        await labelLeaf(store, line.slice("/label".length).trim());
        continue;
      }
      if (line.startsWith("/preset")) {
        await presetCommand(
          line.slice("/preset".length).trim(),
          options.presets,
          console.log,
          confirmVia(readline),
        );
        continue;
      }
      if (line.startsWith("/compact")) {
        const compacted = await compactNow(store, options.provider, line);
        if (compacted) {
          flush?.compactionCompleted();
          agent = buildAgent(store.messages());
          persisted = agent.history().length;
        }
        continue;
      }
      if (line === "/agent" || line.startsWith("/agent ")) {
        const selection = selectAgent(line.slice("/agent".length).trim(), extensions.agents);
        if (selection.changed) {
          activeAgent = selection.definition;
          agent = buildAgent(agent.history());
        }
        continue;
      }
      const submission = await prepareSubmission(line, extensions, runtime);
      if (submission === undefined) continue;
      const turnAgent =
        submission.definition === undefined || submission.definition === activeAgent
          ? agent
          : buildAgentFor(submission.definition, agent.history());
      await runTurn(turnAgent, submission.prompt);
      printUsageLine(turnAgent);
      persisted = await persistNewMessages(store, turnAgent.history(), persisted, checkpoints);
      const flushed = await flushAfterTurn(flush, store, turnAgent.history());
      if (turnAgent !== agent || flushed.length > 0) {
        agent = buildAgent([...turnAgent.history(), ...flushed]);
        persisted = agent.history().length;
      }
    }
  } catch (cause) {
    if (!isReadlineClosed(cause)) throw cause;
  } finally {
    readline.close();
    await mcp?.stop();
  }
  await sweepOnClose(memory);
}

const builtinCommandNames = ["session", "undo", "redo", "label", "preset", "compact", "agent"];

interface Submission {
  prompt: string;
  definition?: AgentDefinition;
}

async function prepareSubmission(
  line: string,
  extensions: WorkspaceExtensions,
  runtime: CommandRuntime,
): Promise<Submission | undefined> {
  const invoked = resolveSlashCommand(extensions.commands, line);
  if (invoked === undefined) return { prompt: line };
  try {
    const prompt = await renderCommand(invoked.command.template, invoked.args, runtime);
    const definition = extensions.agents.find((agent) => agent.name === invoked.command.agent);
    return { prompt, ...(definition !== undefined && { definition }) };
  } catch (cause) {
    console.error(`/${invoked.command.name} failed: ${(cause as Error).message}`);
    return undefined;
  }
}

function selectAgent(
  name: string,
  agents: readonly AgentDefinition[],
): { changed: boolean; definition?: AgentDefinition } {
  if (name === "") {
    listAgents(agents);
    return { changed: false };
  }
  if (name === "none") {
    console.log("back to the default agent");
    return { changed: true };
  }
  const definition = agents.find((candidate) => candidate.name === name);
  if (definition === undefined) {
    listAgents(agents, `unknown agent "${name}"`);
    return { changed: false };
  }
  console.log(`agent → ${definition.name}`);
  return { changed: true, definition };
}

function listAgents(agents: readonly AgentDefinition[], prefix?: string): void {
  if (agents.length === 0) {
    console.log("no agents yet, add one at .keywork/agents/<name>.md");
    return;
  }
  if (prefix !== undefined) console.log(prefix);
  console.log("/agent <name> to switch · /agent none to clear");
  for (const agent of agents) {
    console.log(
      `  ${agent.name}${agent.description === undefined ? "" : ` — ${agent.description}`}`,
    );
  }
}

function reportExtensionFailures(extensions: WorkspaceExtensions): void {
  for (const failure of extensions.failures) {
    console.error(`skipped extension ${failure.file}: ${failure.reason}`);
  }
}

async function tryOpenSession(
  dir: string,
  options: ChatOptions,
): Promise<{ store: SessionStore; seeded: readonly Message[] } | undefined> {
  try {
    return await openOrResumeSession(dir, options.cwd, {
      continueLatest: options.resume ?? false,
      ...(options.resumeId !== undefined && { resumeId: options.resumeId }),
    });
  } catch (cause) {
    console.error((cause as Error).message);
    return undefined;
  }
}

async function labelLeaf(store: SessionStore, name: string): Promise<void> {
  const leaf = store.leafId();
  if (leaf === null) {
    console.log("nothing to label yet");
    return;
  }
  if (name === "") {
    console.log("usage: /label <name>");
    return;
  }
  await store.setLabel(leaf, name);
  console.log(`labeled ${leaf.slice(0, 8)} as "${name}"`);
}

async function compactNow(store: SessionStore, provider: Provider, line: string): Promise<boolean> {
  const instructions = line.slice("/compact".length).trim();
  try {
    const entry = await compactSession(store, provider, {
      ...(instructions !== "" && { instructions }),
    });
    if (entry === undefined) {
      console.log("nothing to compact yet");
      return false;
    }
    console.log(`compacted ${entry.tokensBefore} tokens into a summary`);
    return true;
  } catch (cause) {
    console.error(`compaction failed: ${(cause as Error).message}`);
    return false;
  }
}

function mutationGuard(checkpoints: Checkpoints | undefined): ToolGuard {
  let alwaysAllow = false;
  return {
    confirm: (call) => {
      if (alwaysAllow || !process.stdin.isTTY) return Promise.resolve(true);
      console.log(`\n  ? ${call.name} ${compact(call.arguments)}  [y] allow  [a] always  [n] deny`);
      return nextAnswerKey().then((answer) => {
        alwaysAllow = answer === "always";
        return answer !== "deny";
      });
    },
    ...(checkpoints !== undefined && { beforeMutation: () => checkpoints.capture() }),
  };
}

function nextAnswerKey(): Promise<"allow" | "always" | "deny"> {
  return new Promise((resolve) => {
    const onKeypress = (_chunk: string, key: { name?: string; ctrl?: boolean } | undefined) => {
      const answer = answerFor(key);
      if (answer === undefined) return;
      process.stdin.off("keypress", onKeypress);
      resolve(answer);
    };
    process.stdin.on("keypress", onKeypress);
  });
}

function answerFor(
  key: { name?: string; ctrl?: boolean } | undefined,
): "allow" | "always" | "deny" | undefined {
  if (key?.ctrl === true) return key.name === "c" ? "deny" : undefined;
  if (key?.name === "y" || key?.name === "return") return "allow";
  if (key?.name === "a") return "always";
  if (key?.name === "n" || key?.name === "escape") return "deny";
  return undefined;
}

async function timeTravel(checkpoints: Checkpoints | undefined, line: string): Promise<void> {
  if (checkpoints === undefined) {
    console.log("undo unavailable in this session");
    return;
  }
  const moved = line === "/undo" ? await checkpoints.undo() : await checkpoints.redo();
  if (moved) console.log(line === "/undo" ? "files put back" : "files redone");
  else console.log(line === "/undo" ? "nothing to undo" : "nothing to redo");
}

function greet(
  options: ChatOptions,
  store: SessionStore,
  seeded: readonly Message[],
  extensions: WorkspaceExtensions,
): void {
  console.log(`keywork · ${options.label} · ${options.cwd}`);
  console.log(`session → ${store.file}`);
  if (seeded.length > 0) console.log(`resumed ${seeded.length} messages`);
  console.log(
    `Type to start · Esc stops a turn · "exit" quits · /session stats · /undo takes back the last change · /compact shrinks old context · /label <name> bookmarks here · /preset switches permissions`,
  );
  greetExtensions(extensions);
}

function greetExtensions(extensions: WorkspaceExtensions): void {
  if (extensions.commands.length > 0) {
    const listing = extensions.commands.map((command) => `/${command.name}`).join(" ");
    console.log(`commands: ${listing}`);
  }
  if (extensions.agents.length > 0) {
    const listing = extensions.agents.map((agent) => agent.name).join(", ");
    console.log(`agents (/agent <name>): ${listing}`);
  }
  if (extensions.skills.length > 0) {
    console.log(`skills: ${extensions.skills.map((skill) => skill.name).join(", ")}`);
  }
}

async function runTurn(agent: Agent, line: string): Promise<void> {
  const stopListening = interruptOnEscape(agent);
  try {
    await agent.send(line);
  } catch (cause) {
    console.error(`\nerror: ${(cause as Error).message}`);
  } finally {
    stopListening();
  }
}

function interruptOnEscape(agent: Agent): () => void {
  const stdin = process.stdin;
  if (!stdin.isTTY) return () => {};
  emitKeypressEvents(stdin);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  const onKeypress = (_chunk: string, key: { name?: string; ctrl?: boolean } | undefined) => {
    if (key?.name === "escape" || (key?.ctrl === true && key.name === "c")) agent.interrupt();
  };
  stdin.on("keypress", onKeypress);
  return () => {
    stdin.off("keypress", onKeypress);
    stdin.setRawMode(wasRaw);
  };
}

function confirmVia(
  readline: ReturnType<typeof createInterface>,
): (question: string) => Promise<boolean> {
  return async (question) =>
    (await readline.question(question)).trim().toLowerCase().startsWith("y");
}

function wireStreamingOutput(agent: Agent): void {
  agent.bus.on("turn.delta", ({ delta, replay }) => {
    if (replay !== true && delta.type === "text") process.stdout.write(delta.text);
  });
  agent.bus.on("tool.output", ({ chunk, replay }) => {
    if (replay !== true) process.stdout.write(chunk);
  });
  agent.bus.on("tool.started", ({ call, replay }) => {
    if (replay !== true) console.log(`\n· ${call.name} ${compact(call.arguments)}`);
  });
  agent.bus.on("tool.finished", ({ output, isError, replay }) => {
    if (replay !== true) console.log(`  ${isError ? "✗" : "✓"} ${firstLine(output)}`);
  });
  agent.bus.on("turn.completed", ({ replay }) => {
    if (replay !== true) console.log();
  });
  agent.bus.on("turn.interrupted", () => console.log("\n(interrupted)"));
}

function printUsageLine(agent: Agent): void {
  const { inputTokens, outputTokens } = agent.usage();
  console.log(`  · session ${inputTokens} in / ${outputTokens} out`);
}

function printSessionInfo(agent: Agent, store: SessionStore): void {
  const stats = store.stats();
  const { inputTokens, outputTokens } = agent.usage();
  console.log(`file      ${store.file}`);
  console.log(`id        ${store.header.id}`);
  console.log(
    `entries   ${stats.entries} (${stats.messages} messages, ${stats.branchPoints} branch points, ${stats.labels} labels, ${stats.compactions} compactions)`,
  );
  console.log(`tokens    ${inputTokens} in / ${outputTokens} out this run`);
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

function compact(args: unknown): string {
  const text = JSON.stringify(args) ?? "";
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function firstLine(output: string): string {
  const line = output.split("\n", 1)[0] ?? "";
  return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}

function isReadlineClosed(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  return cause.name === "AbortError" || ("code" in cause && cause.code === "ERR_USE_AFTER_CLOSE");
}
