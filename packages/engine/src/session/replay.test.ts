import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent } from "../agent.ts";
import { type EngineEvents, EventBus } from "../bus.ts";
import { memoryFlushPrompt } from "../memory/flush.ts";
import { textMessage } from "../messages.ts";
import { MockProvider, textTurn, toolCallTurn } from "../mock-provider.ts";
import { defineTool } from "../tools/define.ts";
import { replaySession } from "./replay.ts";
import { SessionStore } from "./store.ts";

type RecordedEvent = { type: string; payload: Record<string, unknown> };

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function sessionFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-replay-"));
  tempDirs.push(dir);
  return join(dir, "session.jsonl");
}

function record(bus: EventBus<EngineEvents>): RecordedEvent[] {
  const events: RecordedEvent[] = [];
  const types = [
    "turn.started",
    "turn.delta",
    "turn.completed",
    "tool.started",
    "tool.finished",
  ] as const;
  for (const type of types) {
    bus.on(type, (payload) => events.push({ type, payload: payload as Record<string, unknown> }));
  }
  return events;
}

function comparable(events: RecordedEvent[]): RecordedEvent[] {
  return events
    .filter((event) => (event.payload.delta as { type?: string } | undefined)?.type !== "done")
    .map(({ type, payload: { replay: _replay, usage: _usage, ...rest } }) => ({
      type,
      payload: rest,
    }));
}

const echoTool = defineTool({
  name: "echo",
  description: "echoes its input",
  schema: z.object({ value: z.string() }),
  run: async ({ value }) => value,
});

describe("replaySession", () => {
  it("emits the live event sequence again, flagged as replay", async () => {
    const provider = new MockProvider([
      toolCallTurn({ type: "tool-call", callId: "c1", name: "echo", arguments: { value: "hi" } }),
      textTurn("all done"),
    ]);
    const agent = new Agent({ provider, tools: [echoTool] });
    const liveEvents = record(agent.bus);
    await agent.send("run the echo");

    const store = await SessionStore.create(await sessionFile(), ".");
    for (const message of agent.history()) await store.append(message);

    const bus = new EventBus<EngineEvents>();
    const replayEvents = record(bus);
    replaySession(store, bus);

    expect(replayEvents.length).toBeGreaterThan(0);
    for (const event of replayEvents) expect(event.payload.replay).toBe(true);
    expect(comparable(replayEvents)).toEqual(comparable(liveEvents));
  });

  it("replays the compacted context, not the summarized history", async () => {
    const store = await SessionStore.create(await sessionFile(), ".");
    await store.append(textMessage("user", "forgotten"));
    const kept = await store.append(textMessage("user", "remembered"));
    await store.appendCompaction({
      summary: "the past",
      firstKeptEntryId: kept.id,
      tokensBefore: 9,
    });

    const bus = new EventBus<EngineEvents>();
    const events = record(bus);
    replaySession(store, bus);

    expect(events.map((event) => event.payload.userText)).toEqual(["the past", "remembered"]);
  });

  it("suppresses memory-flush turns while keeping them in the JSONL record", async () => {
    const store = await SessionStore.create(await sessionFile(), ".");
    await store.append(textMessage("user", "real question"));
    await store.append(textMessage("assistant", "real answer"));
    await store.append(textMessage("user", memoryFlushPrompt));
    await store.append(textMessage("assistant", "tests run on Node, not Bun"));
    await store.append(textMessage("user", "next question"));

    const bus = new EventBus<EngineEvents>();
    const events = record(bus);
    replaySession(store, bus);

    const texts = events
      .filter((event) => event.type === "turn.started" || event.type === "turn.delta")
      .map((event) => event.payload.userText ?? (event.payload.delta as { text?: string })?.text);
    expect(texts).toEqual(["real question", "real answer", "next question"]);
    expect(store.messages()).toHaveLength(5);
  });
});
