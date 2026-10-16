import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  Agent,
  type ContextInjection,
  MemorySearch,
  MemoryStore,
  MockProvider,
  memoryRecallTools,
  pointOfActionRecall,
  SessionStore,
  type Tool,
  type TurnDelta,
  tapJournal,
  textTurn,
  toolCallTurn,
} from "../../packages/engine/src/index.ts";

export interface SessionScript {
  name: string;
  steps: ScriptStep[];
}

export type ScriptStep = { prompt: string; replies: ScriptReply[] } | { compact: string };

export type ScriptReply =
  | { call: string; args: Record<string, unknown>; deny?: true }
  | { say: string };

export const recordedCwd = "/fixture/keywork";

export async function recordSession(
  script: SessionScript,
  options: { vault: string; file: string },
): Promise<void> {
  await mkdir(dirname(options.file), { recursive: true });
  await rm(options.file, { force: true });
  const store = await SessionStore.create(options.file, recordedCwd);
  const memory = new MemoryStore({ vaultRoot: options.vault, trusted: true });
  const search = new MemorySearch(memory);
  const { turns, denied } = scripted(script);
  let agent: Agent | undefined;
  const inject = (injection: ContextInjection) =>
    agent?.bus.emit("context.injected", { injection });
  agent = new Agent({
    provider: new MockProvider(turns),
    tools: [
      ...actionTools,
      ...memoryRecallTools(memory, search, (id) =>
        inject({ source: "memory-recall", id, scope: "workspace" }),
      ),
    ],
    permissions: (call) => (denied.has(call.callId) ? "deny" : "allow"),
    actionRecall: pointOfActionRecall({
      search,
      milliseconds: unhurriedSearchMs,
      onDecision: (decision) => agent?.bus.emit("memory.decided", { decision }),
      onRecall: (id) => inject({ source: "memory-action", id, scope: "workspace" }),
    }),
  });
  const journal = tapJournal(agent.bus, store);
  let persisted = 0;
  for (const step of script.steps) {
    await journal.flush();
    if ("compact" in step) {
      await store.appendCompaction({
        summary: step.compact,
        firstKeptEntryId: store.leafId() ?? "",
        tokensBefore: 0,
      });
      continue;
    }
    await agent.send(step.prompt);
    await journal.flush();
    for (const message of agent.history().slice(persisted)) await store.append(message);
    persisted = agent.history().length;
  }
  journal.stop();
}

const unhurriedSearchMs = 60_000;

const actionTools: Tool[] = ["write", "edit", "bash"].map((name) => ({
  name,
  description: `Recorded stand-in for ${name}: memory recall sees the call, the workspace is never touched.`,
  parameters: { type: "object" },
  mutates: true,
  execute: async () => `${name} done`,
}));

interface Scripted {
  turns: TurnDelta[][];
  denied: Set<string>;
}

function scripted(script: SessionScript): Scripted {
  const turns: TurnDelta[][] = [];
  const denied = new Set<string>();
  for (const step of script.steps) {
    if ("compact" in step) continue;
    for (const reply of step.replies) {
      if ("say" in reply) {
        turns.push(textTurn(reply.say));
        continue;
      }
      const callId = `call-${turns.length + 1}`;
      if (reply.deny === true) denied.add(callId);
      turns.push(
        toolCallTurn({ type: "tool-call", callId, name: reply.call, arguments: reply.args }),
      );
    }
  }
  return { turns, denied };
}
