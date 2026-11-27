import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createTailnet,
  InferenceRegistry,
  keeperNotifications,
  type Message,
  memoryHeldSource,
  memorySettingsSource,
  type Provider,
  type ProviderRegistration,
  textTurn,
  toolCallTurn,
  waitingThroughTheStop,
} from "@keywork/engine";
import { type AskKeeping, AskQueue, EventLog, type KeptAsk } from "@keywork/server";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it, vi } from "vitest";
import { pingFailure } from "../../engine/src/mesh/transport/ping.ts";
import { parseStatus } from "../../engine/src/mesh/transport/status.ts";
import { recordedText } from "../../engine/src/mesh/transport/testing/recorded.ts";
import { type ServedHostOptions, servedHost } from "./serve.ts";
import { followNotifications } from "./serve-notifications.ts";

const tempDir = scratchDirs("keywork-carried-asks-");

describe("a question that waits through a stop", () => {
  it("waits again after the engine starts, and its answer lets that one call through once", async () => {
    const cwd = await tempDir();
    await mkdir(join(cwd, ".keywork", "memory"), { recursive: true });
    await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "carried" }));
    const log = new EventLog();
    const options: ServedHostOptions = {
      cwd,
      sessionDir: await tempDir(),
      userRoot: await tempDir(),
      projectTrusted: true,
      provider: planWriter,
      tailnet: recordedTailnet(),
      permissions: () => "ask",
      checkpoints: "off",
      log,
    };
    const before = await servedHost(options);
    const { id } = await before.create();
    await before.prompt(id, "Write the plan.", "queue");
    await vi.waitFor(async () => expect(await before.asks()).toHaveLength(1));
    await before.close?.();

    const after = await servedHost(options);
    try {
      expect(await after.asks()).toEqual([
        expect.objectContaining({ callId: "w1", carried: true }),
      ]);
      expect(await after.answerAsk("w1", "granted", "session")).toBe("carried-once");

      expect(await after.answerAsk("w1", "granted")).toBe("settled");

      await vi.waitFor(async () =>
        expect((await after.asks()).map((ask) => ask.callId)).toEqual(["w3"]),
      );
      expect(existsSync(join(cwd, "plan.md"))).toBe(true);
      const granted = log
        .since(0)
        .filter((envelope) => envelope.type === "gate.permission")
        .map((envelope) => (envelope.payload as { decision: unknown }).decision);
      expect(granted).toContainEqual(
        expect.objectContaining({ callId: "w2", verdict: "granted", gate: "user", scope: "once" }),
      );
    } finally {
      await after.close?.();
    }
  });

  it("keeps what a turn did when the engine is killed partway, so the answered question carries on from there and delivers every file", async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const userRoot = await tempDir();
    const shadow = await tempDir();
    await mkdir(join(cwd, ".keywork", "memory"), { recursive: true });
    await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "cut" }));
    for (const file of renamed) await writeFile(join(cwd, file), "export const largest = 1;\n");
    const heard: Message[][] = [];
    const provider = renamer(heard);
    const models = new InferenceRegistry();
    models.register(registrationOf(provider));
    const served = (log: EventLog) =>
      servedHost({
        cwd,
        sessionDir,
        userRoot,
        projectTrusted: true,
        provider,
        inference: { bind: (reference) => models.bind(reference), provider: () => provider },
        tailnet: recordedTailnet(),
        permissions: (call) => (pathOf(call.arguments) === "c.ts" ? "ask" : "allow"),
        checkpoints: "on",
        checkpointsGitDir: shadow,
        log,
      });
    const killed = await served(new EventLog());
    const pip = await killed.creatures?.create({ name: "Pip" });
    const conversation = (await killed.creatures?.read(pip?.slug ?? ""))?.conversation ?? "";
    await killed.prompt(conversation, "Rename largest to best in a.ts, b.ts and c.ts.", "queue");
    await vi.waitFor(async () => expect(await killed.asks()).toHaveLength(1));

    const log = new EventLog({ capacity: 10_000 });
    const after = await served(log);
    try {
      expect(await after.asks()).toEqual([
        expect.objectContaining({ callId: "c1", carried: true }),
      ]);
      expect(await after.answerAsk("c1", "granted")).toBe("settled");
      await vi.waitFor(() => expect(deliveredIn(log, conversation)).toHaveLength(1), {
        timeout: 10_000,
      });

      expect(resultsIn(heard.find(carriesTheAnswer) ?? [])).toEqual({
        a1: expect.objectContaining({ isError: false }),
        b1: expect.objectContaining({ isError: false }),
        c1: { output: waitingThroughTheStop, isError: true },
      });
      expect(payloadsIn(log, conversation, "gate.permission")).toContainEqual({
        decision: expect.objectContaining({ callId: "c1", verdict: "granted", scope: "once" }),
      });
      const { deliveries } = (await after.deliveries?.list()) ?? { deliveries: [] };
      expect(deliveries).toEqual([
        expect.objectContaining({
          id: deliveredIn(log, conversation)[0],
          files: renamed.map((path) => ({ path, added: 1, deleted: 1 })),
        }),
      ]);
      await vi.waitFor(async () =>
        expect((await after.list()).find(({ id }) => id === conversation)?.working).toBe(false),
      );
      const read = await after.read(conversation);
      expect(read?.outcomes.map(({ outcome }) => outcome)).toEqual(["shutdown", "completed"]);
    } finally {
      await after.close?.();
      await killed.close?.();
    }
  });

  it("rings once: the engine starting again does not announce it a second time", () => {
    let kept: readonly KeptAsk[] = [];
    const keeping: AskKeeping = {
      read: () => kept,
      write: (asks) => {
        kept = asks;
      },
    };
    const held = memoryHeldSource();
    const settings = memorySettingsSource();
    const rang: string[] = [];
    const served = () => {
      const asks = new AskQueue({ keeping });
      const notifications = keeperNotifications({ settings, held });
      notifications.subscribe((event) => {
        if (event.type === "notifications.notice" && !event.payload.notice.held) {
          rang.push(event.payload.notice.id);
        }
      });
      const followed = followNotifications({
        notifications,
        asks,
        log: new EventLog(),
        creatureOf: () => "osk",
        nameOf: () => "Osk",
        chore: async () => undefined,
        notice: () => undefined,
      });
      return {
        asks,
        stop: () => {
          asks.close();
          followed.close();
          notifications.close();
        },
      };
    };

    const before = served();
    void before.asks.ask("s1", { type: "tool-call", callId: "w1", name: "write", arguments: plan });
    before.stop();
    const after = served();

    expect(after.asks.list()).toEqual([expect.objectContaining({ callId: "w1", carried: true })]);
    expect(rang).toEqual(["ask:w1"]);
    after.stop();
  });
});

const plan = { path: "plan.md", content: "the plan\n" };

const planWriter: Provider = {
  name: "mock",
  modelId: "scripted",
  async *stream(request) {
    yield* replyTo(request.messages);
  },
};

function replyTo(messages: readonly Message[]) {
  const last = messages.at(-1);
  const said = JSON.stringify(last);
  const write = (callId: string) =>
    toolCallTurn({ type: "tool-call", callId, name: "write", arguments: plan });
  if (last?.role === "user" && said.includes("answered the question that waited"))
    return write("w2");
  if (last?.role === "user") return write("w1");
  if (said.includes('"callId":"w2"')) return write("w3");
  return textTurn("I will wait for the keeper.");
}

const renamed = ["a.ts", "b.ts", "c.ts"];

function renamer(heard: Message[][]): Provider {
  return {
    name: "mock",
    modelId: "scripted",
    async *stream(request) {
      heard.push([...request.messages]);
      yield* renaming(request.messages);
    },
  };
}

function renaming(messages: readonly Message[]) {
  const rename = (callId: string, path: string) =>
    toolCallTurn({
      type: "tool-call",
      callId,
      name: "write",
      arguments: { path, content: "export const best = 1;\n" },
    });
  if (carriesTheAnswer(messages)) return rename("c2", "c.ts");
  if (messages.at(-1)?.role === "user") return rename("a1", "a.ts");
  const answered = Object.keys(resultsIn(messages.slice(-1)));
  if (answered.includes("a1")) return rename("b1", "b.ts");
  if (answered.includes("b1")) return rename("c1", "c.ts");
  return textTurn("Renamed it in a.ts, b.ts and c.ts.");
}

function registrationOf(provider: Provider): ProviderRegistration {
  return {
    name: provider.name,
    protocol: "chat-completions",
    endpoint: "https://mock.invalid/v1",
    credential: { kind: "none" },
    models: [{ id: provider.modelId ?? "scripted", origin: "declared" }],
    openCatalog: false,
    enabled: true,
  };
}

function carriesTheAnswer(messages: readonly Message[]): boolean {
  const last = messages.at(-1);
  return (
    last?.role === "user" && JSON.stringify(last).includes("answered the question that waited")
  );
}

function resultsIn(
  messages: readonly Message[],
): Record<string, { output: string; isError: boolean }> {
  return Object.fromEntries(
    messages.flatMap((message) =>
      message.parts.flatMap((part) =>
        part.type === "tool-result"
          ? [[part.callId, { output: part.output, isError: part.isError }] as const]
          : [],
      ),
    ),
  );
}

function pathOf(args: unknown): unknown {
  return typeof args === "object" && args !== null ? (args as { path?: unknown }).path : undefined;
}

function payloadsIn(log: EventLog, session: string, type: string): unknown[] {
  return log
    .since(0)
    .filter((envelope) => envelope.sessionId === session && envelope.type === type)
    .map((envelope) => envelope.payload);
}

function deliveredIn(log: EventLog, session: string): string[] {
  return payloadsIn(log, session, "turn.completed").flatMap((payload) => {
    const { delivery } = payload as { delivery?: string | null };
    return typeof delivery === "string" ? [delivery] : [];
  });
}

function recordedTailnet() {
  return createTailnet({
    name: "recorded",
    status: async () => parseStatus(recordedText("status-running")),
    whois: async () => null,
    ping: async () => pingFailure("unused"),
    serve: async () => ({ serving: false, funnel: [] }),
  });
}
