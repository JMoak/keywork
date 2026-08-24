import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Agent,
  MockProvider,
  replaySession,
  SessionStore,
  type Tool,
  textTurn,
  toolCallTurn,
} from "@keywork/engine";
import { afterEach, describe, expect, it } from "vitest";
import { type TranscriptEntry, TranscriptFeed } from "./transcript-feed.ts";

function followed(agent: Agent, now?: () => number): TranscriptFeed {
  const feed = new TranscriptFeed(() => {}, now);
  feed.follow(agent.bus);
  return feed;
}

describe("TranscriptFeed", () => {
  it("streams assistant text into one growing entry and counts activity", async () => {
    const agent = new Agent({
      provider: new MockProvider([
        [
          { type: "text", text: "one " },
          { type: "text", text: "two" },
          { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
        ],
      ]),
    });
    const feed = followed(agent);
    await agent.send("go");
    expect(feed.entries).toEqual([
      { kind: "user", text: "go" },
      { kind: "assistant", text: "one two" },
    ]);
    expect(feed.activity).toBe(2);
  });

  it("reports streaming progress only for the entry still being streamed", () => {
    const agent = new Agent({ provider: new MockProvider([]) });
    const feed = followed(agent);
    agent.bus.emit("turn.delta", { delta: { type: "text", text: "one " } });
    const entry = feed.entries[0] as TranscriptEntry;
    expect(feed.streamingProgress(entry)).toBe(0);
    agent.bus.emit("turn.delta", { delta: { type: "text", text: "two " } });
    agent.bus.emit("turn.delta", { delta: { type: "text", text: "three " } });
    expect(feed.streamingProgress(entry)).toBe(0.5);
    agent.bus.emit("turn.interrupted", { message: { role: "assistant", parts: [] } });
    expect(feed.streamingProgress(entry)).toBeUndefined();
    expect(feed.entries.at(-1)).toEqual({ kind: "info", text: "· interrupted" });
  });

  it("records a tool run with its timing, outcome, and folded detail", async () => {
    const echo: Tool = {
      name: "echo",
      description: "echoes",
      parameters: { type: "object" },
      execute: async (args) => `echo: ${(args as { text: string }).text}`,
    };
    let clock = 1_000;
    const agent = new Agent({
      provider: new MockProvider([
        toolCallTurn({ type: "tool-call", callId: "c1", name: "echo", arguments: { text: "hi" } }),
        textTurn("done"),
      ]),
      tools: [echo],
    });
    const feed = followed(agent, () => {
      clock += 250;
      return clock;
    });
    await agent.send("use echo");
    expect(feed.entries.map((entry) => entry.kind)).toEqual(["user", "tool", "assistant"]);
    expect(feed.entries[1]).toMatchObject({
      failed: false,
      text: "echo hi · 250ms · done",
      run: { detail: ["echo: hi"], folded: true, outputChars: 8 },
    });
  });

  it("follows live tool output in the row text and settles it on finish", () => {
    const agent = new Agent({ provider: new MockProvider([]) });
    const feed = followed(agent);
    agent.bus.emit("tool.started", {
      call: { type: "tool-call", callId: "c1", name: "bash", arguments: { command: "ls" } },
    });
    expect(feed.entries[0]?.text).toBe("bash ls · running");
    agent.bus.emit("tool.output", { chunk: "one\ntwo", callId: "c1" });
    expect(feed.entries[0]?.text).toBe("bash ls · two");
    agent.bus.emit("tool.finished", { callId: "c1", output: "one\ntwo\n", isError: false });
    expect(feed.entries[0]?.text).toMatch(/^bash ls · \d+ms · done$/);
  });

  it("carries the failure reason on the collapsed row", () => {
    const agent = new Agent({ provider: new MockProvider([]) });
    const feed = followed(agent);
    agent.bus.emit("tool.started", {
      call: { type: "tool-call", callId: "c1", name: "detonate", arguments: {} },
    });
    agent.bus.emit("tool.finished", { callId: "c1", output: "boom\nmore", isError: true });
    expect(feed.entries[0]).toMatchObject({ failed: true });
    expect(feed.entries[0]?.text).toMatch(/ · failed · boom$/);
  });

  it("caps disclosed detail and marks the overflow", () => {
    const agent = new Agent({ provider: new MockProvider([]) });
    const feed = followed(agent);
    agent.bus.emit("tool.started", {
      call: { type: "tool-call", callId: "c1", name: "spool", arguments: {} },
    });
    const output = Array.from({ length: 20 }, (_, at) => `line ${at + 1}`).join("\n");
    agent.bus.emit("tool.finished", { callId: "c1", output, isError: false });
    const entry = feed.entries[0] as Extract<TranscriptEntry, { kind: "tool" }>;
    expect(entry.run?.detail).toHaveLength(13);
    expect(entry.run?.detail?.at(-1)).toBe("… 8 more lines");
  });

  it("toggles folds only on rows that have detail", () => {
    const agent = new Agent({ provider: new MockProvider([]) });
    const feed = followed(agent);
    expect(feed.toggleLatestFold()).toBe(false);
    agent.bus.emit("tool.started", {
      call: { type: "tool-call", callId: "c1", name: "echo", arguments: {} },
    });
    const entry = feed.entries[0] as TranscriptEntry;
    expect(feed.toggleFold(entry)).toBe(false);
    agent.bus.emit("tool.finished", { callId: "c1", output: "out", isError: false });
    expect(feed.toggleLatestFold()).toBe(true);
    expect(feed.disclosableIndices()).toEqual([0]);
    expect(entry).toMatchObject({ run: { folded: false } });
  });

  it("stops following once unsubscribed", () => {
    const agent = new Agent({ provider: new MockProvider([]) });
    const feed = new TranscriptFeed(() => {});
    const stop = feed.follow(agent.bus);
    stop();
    agent.bus.emit("turn.delta", { delta: { type: "text", text: "ghost" } });
    expect(feed.entries).toEqual([]);
  });
});

describe("prompt identity", () => {
  it("carries the replayed entry id on user entries and leaves summaries anonymous", () => {
    const agent = new Agent({ provider: new MockProvider([]) });
    const feed = followed(agent);
    agent.bus.emit("turn.started", { userText: "earlier work", replay: true });
    agent.bus.emit("turn.started", { userText: "first", replay: true, entryId: "u1" });
    expect(feed.entries).toEqual([
      { kind: "user", text: "earlier work" },
      { kind: "user", text: "first", entryId: "u1" },
    ]);
    expect(feed.promptIndices()).toEqual([0, 1]);
  });

  it("assigns adopted ids to live prompts in send order, never to replayed ones", async () => {
    const agent = new Agent({ provider: new MockProvider([textTurn("a"), textTurn("b")]) });
    const feed = followed(agent);
    agent.bus.emit("turn.started", { userText: "revived", replay: true });
    await agent.send("one");
    await agent.send("two");
    feed.adoptPromptId("u1");
    feed.adoptPromptId("u2");
    feed.adoptPromptId("stray");
    expect(feed.entries.filter((entry) => entry.kind === "user")).toEqual([
      { kind: "user", text: "revived" },
      { kind: "user", text: "one", entryId: "u1" },
      { kind: "user", text: "two", entryId: "u2" },
    ]);
  });
});

const replayTempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    replayTempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function replaySessionFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-feed-replay-"));
  replayTempDirs.push(dir);
  return join(dir, "session.jsonl");
}

describe("session replay rendering", () => {
  const listTool: Tool = {
    name: "list",
    description: "lists files",
    parameters: { type: "object" },
    execute: async () => "total 4\ndrwxr-xr-x 2 u u 4096 .",
  };

  async function livedAndRevived(): Promise<{ live: TranscriptFeed; revived: TranscriptFeed }> {
    const liveAgent = new Agent({
      provider: new MockProvider([
        [
          {
            type: "tool-call",
            call: { type: "tool-call", callId: "c1", name: "list", arguments: {} },
          },
          { type: "text", text: "Counting the files now." },
          { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
        ],
        textTurn("There are 4 files here."),
      ]),
      tools: [listTool],
    });
    const live = followed(liveAgent);
    await liveAgent.send("how many files?");

    const store = await SessionStore.create(await replaySessionFile(), ".");
    for (const message of liveAgent.history()) await store.append(message);
    const revivedAgent = new Agent({ provider: new MockProvider([]), history: store.messages() });
    const revived = followed(revivedAgent);
    replaySession(store, revivedAgent.bus);
    return { live, revived };
  }

  it("renders a revived tool-call turn as it rendered live, minus live-only timings", async () => {
    const { live, revived } = await livedAndRevived();
    const rendered = (entries: readonly TranscriptEntry[]) =>
      entries.map(({ kind, text }) => ({
        kind,
        text: text.replace(/ · \d+(\.\d+)?(ms|s|m)/, ""),
      }));
    expect(rendered(revived.entries)).toEqual(rendered(live.entries));
  });

  it("never merges prose across turns around a replayed tool entry", async () => {
    const { revived } = await livedAndRevived();
    expect(revived.entries.map((entry) => entry.kind)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(revived.entries[1]).toEqual({ kind: "assistant", text: "Counting the files now." });
    expect(revived.entries[2]).toMatchObject({ kind: "tool", text: "list · done" });
    expect(revived.entries[3]).toEqual({ kind: "assistant", text: "There are 4 files here." });
  });
});
