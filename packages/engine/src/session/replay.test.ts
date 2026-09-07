import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { defaultToolOutputBudget } from "./spill.ts";
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
    .map(({ type, payload: { replay: _replay, usage: _usage, entryId: _entryId, ...rest } }) => ({
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

  it("keeps prose and tool events in live order when a tool call precedes text", async () => {
    const provider = new MockProvider([
      [
        {
          type: "tool-call",
          call: { type: "tool-call", callId: "c1", name: "echo", arguments: { value: "hi" } },
        },
        { type: "text", text: "Running the echo now." },
        { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
      ],
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

    expect(comparable(replayEvents)).toEqual(comparable(liveEvents));
  });

  it("replays a spilled tool result identically whether or not the spill file survives", async () => {
    const firehose = defineTool({
      name: "firehose",
      description: "emits several megabytes",
      schema: z.object({}),
      run: async () => "0123456789\n".repeat(300_000),
    });
    const provider = new MockProvider([
      toolCallTurn({ type: "tool-call", callId: "c1", name: "firehose", arguments: {} }),
      textTurn("read it"),
    ]);
    const file = await sessionFile();
    const store = await SessionStore.create(file, ".");
    const agent = new Agent({ provider, tools: [firehose], spills: store.spills() });
    const liveEvents = record(agent.bus);
    await agent.send("go");
    for (const message of agent.history()) await store.append(message);

    const recorded = await readFile(file, "utf8");
    const finished = liveEvents.find((event) => event.type === "tool.finished");
    const stored = (await SessionStore.open(file)).messages()[2]?.parts[0];
    expect(stored?.type === "tool-result" && Buffer.byteLength(stored.output)).toBeLessThanOrEqual(
      defaultToolOutputBudget,
    );
    expect(recorded).toContain(`"spill":${JSON.stringify(finished?.payload.spill)}`);

    const spillPresent = new EventBus<EngineEvents>();
    const withSpill = record(spillPresent);
    replaySession(await SessionStore.open(file), spillPresent);
    await store.spills().remove();
    const spillGone = new EventBus<EngineEvents>();
    const withoutSpill = record(spillGone);
    replaySession(await SessionStore.open(file), spillGone);

    expect(comparable(withoutSpill)).toEqual(comparable(withSpill));
    expect(comparable(withSpill)).toEqual(comparable(liveEvents));
    expect(await readFile(file, "utf8")).toBe(recorded);
  });

  it("replays visible thinking ahead of the answer it preceded", async () => {
    const store = await SessionStore.create(await sessionFile(), ".");
    await store.append(textMessage("user", "why"));
    await store.append({
      role: "assistant",
      parts: [
        { type: "visible-thinking", text: "Weighing it." },
        { type: "text", text: "Because." },
      ],
    });

    const bus = new EventBus<EngineEvents>();
    const events = record(bus);
    replaySession(store, bus);

    expect(events.filter((event) => event.type === "turn.delta").map((e) => e.payload)).toEqual([
      { delta: { type: "visible-thinking", text: "Weighing it." }, replay: true },
      { delta: { type: "text", text: "Because." }, replay: true },
    ]);
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
