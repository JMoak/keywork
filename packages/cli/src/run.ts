import { join } from "node:path";
import {
  Agent,
  buildSystemPrompt,
  coreTools,
  loadProjectInstructions,
  type Message,
  MockProvider,
  messageText,
  type Provider,
  SessionStore,
  textTurn,
} from "@keywork/engine";

export interface RunOptions {
  prompt: string;
  cwd: string;
  json: boolean;
  sessionDir?: string;
  provider?: Provider;
  print?: (line: string) => void;
}

export async function runHeadless(options: RunOptions): Promise<Message> {
  const print = options.print ?? console.log;
  const emit = (type: string, payload: unknown) => {
    if (options.json) print(JSON.stringify({ type, ...(payload as object) }));
  };

  const provider = options.provider ?? placeholderProvider(options.prompt);
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

function placeholderProvider(prompt: string): Provider {
  return new MockProvider([
    textTurn(`keywork engine is alive; no live provider is configured yet. You said: ${prompt}`),
  ]);
}

async function persistSession(options: RunOptions, history: readonly Message[]): Promise<void> {
  if (options.sessionDir === undefined) return;
  const file = join(options.sessionDir, `${Date.now()}.jsonl`);
  const store = await SessionStore.create(file, options.cwd);
  for (const message of history) await store.append(message);
}
