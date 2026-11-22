import { Agent, MockProvider } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { AppProbe } from "./probe.ts";
import { TranscriptFeed } from "./transcript-feed.ts";
import { nextVerbosity, toolGroups } from "./transcript-verbosity.ts";
import { TranscriptView } from "./transcript-view.ts";

const syncTick = (flush: () => void) => flush();

function scriptedFeed(): { feed: TranscriptFeed; agent: Agent } {
  const agent = new Agent({ provider: new MockProvider([]) });
  const feed = new TranscriptFeed(
    () => {},
    () => 0,
    syncTick,
  );
  feed.follow(agent.bus);
  return { feed, agent };
}

function runTool(agent: Agent, callId: string, name: string, args: object, output: string): void {
  agent.bus.emit("tool.started", {
    call: { type: "tool-call", callId, name, arguments: args },
  });
  agent.bus.emit("tool.finished", { callId, output, isError: false });
}

function readsThenBash(): TranscriptFeed {
  const { feed, agent } = scriptedFeed();
  agent.bus.emit("turn.started", { userText: "look around" });
  runTool(agent, "r1", "read", { path: "a.ts" }, "alpha");
  runTool(agent, "r2", "read", { path: "b.ts" }, "beta");
  runTool(agent, "r3", "read", { path: "c.ts" }, "gamma");
  runTool(agent, "r4", "read", { path: "d.ts" }, "delta");
  runTool(agent, "b1", "bash", { command: "ls -la" }, "one\ntwo\nthree\nfour\nfive");
  agent.bus.emit("turn.delta", { delta: { type: "text", text: "Done looking." } });
  agent.bus.emit("turn.completed", {
    message: { role: "assistant", parts: [] },
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  return feed;
}

function rows(feed: TranscriptFeed, width = 80): string[] {
  return new TranscriptView()
    .frame(feed, { width, rows: 60 }, { scrollBack: 0 })
    .lines.map((line) => `${line.stamp ?? ""}${line.text}`);
}

describe("verbosity levels", () => {
  it("cycles low, medium, high and back, starting at medium", () => {
    const { feed } = scriptedFeed();
    expect(feed.verbosity).toBe("medium");
    expect(nextVerbosity("medium")).toBe("high");
    expect(feed.cycleVerbosity()).toBe("high");
    expect(feed.cycleVerbosity()).toBe("low");
    expect(feed.cycleVerbosity()).toBe("medium");
  });

  it("medium collapses adjacent reads into one row and keeps the other rows as they were", () => {
    const shown = rows(readsThenBash());
    expect(shown).toEqual([
      "█ look around",
      "░ read 4 files: a.ts, b.ts, c.ts, d.ts · done",
      "░ bash ls -la · 0ms · done",
      "▓ Done looking.",
    ]);
  });

  it("low folds every run of agent tool calls into one counted row", () => {
    const feed = readsThenBash();
    feed.verbosity = "low";
    expect(rows(feed)).toEqual([
      "█ look around",
      "░ 5 tools: read 4, bash 1 · done",
      "▓ Done looking.",
    ]);
  });

  it("high shows full arguments and the first lines of each result under every row", () => {
    const feed = readsThenBash();
    feed.verbosity = "high";
    const shown = rows(feed);
    expect(shown.slice(0, 4)).toEqual([
      "█ look around",
      "░ read a.ts · 0ms · done",
      '  {"path":"a.ts"}',
      "  alpha",
    ]);
    const bash = shown.indexOf("░ bash ls -la · 0ms · done");
    expect(shown.slice(bash + 1, bash + 6)).toEqual([
      '  {"command":"ls -la"}',
      "  one",
      "  two",
      "  three",
      "  …",
    ]);
  });

  it("leaves a lone read alone and never groups a user's own shell run", () => {
    const { feed, agent } = scriptedFeed();
    runTool(agent, "r1", "read", { path: "a.ts" }, "alpha");
    feed.beginUserTool({
      type: "tool-call",
      callId: "u1",
      name: "bash",
      arguments: { command: "ls" },
    });
    feed.finishUserTool("u1", "out", false);
    runTool(agent, "r2", "read", { path: "b.ts" }, "beta");
    expect(toolGroups(feed.entries, "medium").size).toBe(0);
    expect(toolGroups(feed.entries, "low").size).toBe(0);
  });

  it("takes grouped rows out of the disclosure walk and refuses to fold them", () => {
    const feed = readsThenBash();
    const firstRead = feed.entries[1];
    expect(feed.disclosableIndices()).toEqual([5]);
    expect(firstRead === undefined ? true : feed.toggleFold(firstRead)).toBe(false);
    feed.verbosity = "high";
    expect(feed.disclosableIndices()).toEqual([1, 2, 3, 4, 5]);
  });

  it("re-renders the group row as a new read joins it and as reads settle", () => {
    const { feed, agent } = scriptedFeed();
    const view = new TranscriptView();
    const frame = () =>
      view.frame(feed, { width: 80, rows: 20 }, { scrollBack: 0 }).lines.map((line) => line.text);
    runTool(agent, "r1", "read", { path: "a.ts" }, "alpha");
    agent.bus.emit("tool.started", {
      call: { type: "tool-call", callId: "r2", name: "read", arguments: { path: "b.ts" } },
    });
    expect(frame()).toEqual(["read 2 files: a.ts, b.ts · running"]);
    agent.bus.emit("tool.finished", { callId: "r2", output: "x", isError: true });
    expect(frame()).toEqual(["read 2 files: a.ts, b.ts · 1 failed"]);
    runTool(agent, "r3", "read", { path: "c.ts" }, "gamma");
    expect(frame()).toEqual(["read 3 files: a.ts, b.ts, c.ts · 1 failed"]);
  });
});

describe("the verbosity verb", () => {
  it("cycles the focused conversation on leader v and shows the chord on its palette command", () => {
    const probe = new AppProbe();
    expect(probe.core.keymap.describe("transcript.verbosity")).toBe("ctrl+k v");
    const command = probe.core.registry.all().find((entry) => entry.name === "verbosity");
    expect(command?.shortcut).toBe("ctrl+k v");
    probe.keys("ctrl+k", "v");
    expect(probe.model()?.feed.verbosity).toBe("high");
    probe.keys("v");
    expect(probe.model()?.feed.verbosity).toBe("low");
  });
});
