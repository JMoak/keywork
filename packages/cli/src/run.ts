import { join } from "node:path";
import {
  Agent,
  buildSystemPrompt,
  coreTools,
  loadProjectInstructions,
  type Message,
  messageText,
  type Provider,
  SessionStore,
} from "@keywork/engine";
import { providerSetupHint } from "./provider.ts";
import { newSessionFileName } from "./sessions.ts";

export interface RunOptions {
  prompt: string;
  cwd: string;
  json: boolean;
  sessionDir?: string;
  provider?: Provider;
  print?: (line: string) => void;
  printError?: (line: string) => void;
  exit?: (code: number) => never;
}

export async function runHeadless(options: RunOptions): Promise<Message> {
  const provider = options.provider ?? refuseWithoutProvider(options);
  const print = options.print ?? console.log;
  const emit = (type: string, payload: unknown) => {
    if (options.json) print(JSON.stringify({ type, ...(payload as object) }));
  };

  const instructions = await loadProjectInstructions(options.cwd);
  const agent = new Agent({
    provider,
    tools: coreTools(options.cwd),
    systemPrompt: buildSystemPrompt(instructions),
  });

  agent.bus.on("turn.started", (payload) => emit("turn.started", payload));
  agent.bus.on("turn.delta", (payload) => emit("turn.delta", payload));
  agent.bus.on("tool.started", (payload) => emit("tool.started", payload));
  agent.bus.on("tool.finished", (payload) => emit("tool.finished", payload));
  agent.bus.on("turn.completed", (payload) => emit("turn.completed", payload));
  agent.bus.on("turn.interrupted", (payload) => emit("turn.interrupted", payload));

  const final = await agent.send(options.prompt);
  if (!options.json) print(messageText(final));
  await persistSession(options, agent.history());
  return final;
}

function refuseWithoutProvider(options: RunOptions): never {
  const printError = options.printError ?? console.error;
  printError(providerSetupHint);
  return (options.exit ?? process.exit)(1);
}

async function persistSession(options: RunOptions, history: readonly Message[]): Promise<void> {
  if (options.sessionDir === undefined) return;
  const file = join(options.sessionDir, newSessionFileName());
  const store = await SessionStore.create(file, options.cwd);
  for (const message of history) await store.append(message);
}
