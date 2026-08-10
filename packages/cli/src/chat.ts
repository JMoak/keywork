import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import {
  Agent,
  buildSystemPrompt,
  Checkpoints,
  coreTools,
  loadProjectInstructions,
  type Message,
  type Provider,
  type SessionStore,
  type ToolGuard,
} from "@keywork/engine";
import { defaultSessionDir, snapshotGitDir } from "./paths.ts";
import { openOrResumeSession } from "./sessions.ts";

export interface ChatOptions {
  cwd: string;
  provider: Provider;
  label: string;
  sessionDir?: string;
  resume?: boolean;
}

export async function chat(options: ChatOptions): Promise<void> {
  const instructions = await loadProjectInstructions(options.cwd);
  const dir = options.sessionDir ?? defaultSessionDir(options.cwd);
  const { store, seeded } = await openOrResumeSession(dir, options.cwd, options.resume ?? false);
  const checkpoints = await openCheckpoints(options.cwd);

  const agent = new Agent({
    provider: options.provider,
    tools: coreTools(options.cwd),
    systemPrompt: buildSystemPrompt(instructions),
    history: seeded,
    guard: mutationGuard(checkpoints),
  });
  wireStreamingOutput(agent);
  greet(options, store, seeded);

  const readline = createInterface({ input: process.stdin, output: process.stdout });
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
      await runTurn(agent, line);
      printUsageLine(agent);
      persisted = await persistNewMessages(store, agent.history(), persisted);
    }
  } catch (cause) {
    if (!isReadlineClosed(cause)) throw cause;
  } finally {
    readline.close();
  }
}

async function openCheckpoints(cwd: string): Promise<Checkpoints | undefined> {
  try {
    return await Checkpoints.open({ worktree: cwd, gitDir: snapshotGitDir(cwd) });
  } catch (cause) {
    console.log(`undo unavailable — ${(cause as Error).message}`);
    return undefined;
  }
}

function mutationGuard(checkpoints: Checkpoints | undefined): ToolGuard {
  let alwaysAllow = false;
  return {
    confirm: (call) => {
      if (alwaysAllow || !process.stdin.isTTY) return Promise.resolve(true);
      console.log(`\n  ? ${call.name} ${compact(call.arguments)} — y allow · a always · n deny`);
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
  if (moved) console.log(line === "/undo" ? "files restored" : "files brought forward");
  else console.log(line === "/undo" ? "nothing to undo" : "nothing to redo");
}

function greet(options: ChatOptions, store: SessionStore, seeded: readonly Message[]): void {
  console.log(`keywork · ${options.label} · ${options.cwd}`);
  console.log(`session → ${store.file}`);
  if (seeded.length > 0) console.log(`resumed ${seeded.length} messages`);
  console.log(
    `Ask for anything · Esc interrupts a running turn · "exit" quits · /session for stats · /undo reverts the last agent change`,
  );
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

function wireStreamingOutput(agent: Agent): void {
  agent.bus.on("turn.delta", ({ delta }) => {
    if (delta.type === "text") process.stdout.write(delta.text);
  });
  agent.bus.on("tool.started", ({ call }) => {
    console.log(`\n· ${call.name} ${compact(call.arguments)}`);
  });
  agent.bus.on("tool.finished", ({ output, isError }) => {
    console.log(`  ${isError ? "✗" : "✓"} ${firstLine(output)}`);
  });
  agent.bus.on("turn.completed", () => console.log());
  agent.bus.on("turn.interrupted", () => console.log("\n— interrupted"));
}

function printUsageLine(agent: Agent): void {
  const { inputTokens, outputTokens } = agent.usage();
  console.log(`  · session ${inputTokens} in / ${outputTokens} out`);
}

function printSessionInfo(agent: Agent, store: SessionStore): void {
  const { inputTokens, outputTokens } = agent.usage();
  console.log(`file      ${store.file}`);
  console.log(`messages  ${agent.history().length}`);
  console.log(`tokens    ${inputTokens} in / ${outputTokens} out`);
}

async function persistNewMessages(
  store: SessionStore,
  history: readonly Message[],
  persisted: number,
): Promise<number> {
  for (const message of history.slice(persisted)) await store.append(message);
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
