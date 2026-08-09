import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import {
  Agent,
  buildSystemPrompt,
  coreTools,
  loadProjectInstructions,
  type Message,
  type Provider,
  type SessionStore,
} from "@keywork/engine";
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

  const agent = new Agent({
    provider: options.provider,
    tools: coreTools(options.cwd),
    systemPrompt: buildSystemPrompt(instructions),
    history: seeded,
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

function greet(options: ChatOptions, store: SessionStore, seeded: readonly Message[]): void {
  console.log(`keywork · ${options.label} · ${options.cwd}`);
  console.log(`session → ${store.file}`);
  if (seeded.length > 0) console.log(`resumed ${seeded.length} messages`);
  console.log(
    `Ask for anything · Esc interrupts a running turn · "exit" quits · /session for stats`,
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

function defaultSessionDir(cwd: string): string {
  const projectKey = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  return join(homedir(), ".keywork", "sessions", projectKey);
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
