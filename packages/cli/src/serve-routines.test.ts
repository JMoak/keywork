import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Creature,
  Delivery,
  Message,
  RunRow,
  ThreadReport,
  ThreadSignal,
} from "@keywork/engine";
import type { BusEnvelope } from "@keywork/server";
import { describe, expect, it } from "vitest";
import { conversationDeliverer, creatureDirectoryOver, ThreadWatch } from "./serve-routines.ts";

describe("a chore's thread watch", () => {
  it("adds up the run's usage and reports the reply with the session's spend", async () => {
    const { signals, observe, settled } = watching(0.02);
    observe("turn.delta", {
      delta: { type: "done", usage: { inputTokens: 100, outputTokens: 5 } },
    });
    observe("turn.delta", { delta: { type: "text", text: "x" } });
    observe("turn.delta", { delta: { type: "done", usage: { inputTokens: 40, outputTokens: 7 } } });
    observe("turn.completed", { message: reply("Nothing needs you."), usage: zero });
    await settled();

    expect(signals).toEqual([
      { kind: "spend", costUsd: 0.02 },
      { kind: "spend", costUsd: 0.02 },
      {
        kind: "turn-completed",
        text: "Nothing needs you.",
        usage: { inputTokens: 140, outputTokens: 12 },
        costUsd: 0.02,
      },
    ]);
  });

  it("says nothing about spend while the session's cost is unknown", async () => {
    const { signals, observe, settled } = watching(null);
    observe("turn.delta", { delta: { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } });
    observe("turn.completed", { message: reply("done"), usage: zero });
    await settled();

    expect(signals).toEqual([
      {
        kind: "turn-completed",
        text: "done",
        usage: { inputTokens: 1, outputTokens: 1 },
        costUsd: null,
      },
    ]);
  });

  it("passes on interruptions, failures, asks and the keeper's answers, in order", async () => {
    const { signals, observe, settled } = watching(null);
    observe("gate.ask", { ask: { tool: "write", callId: "c1", arguments: {}, rule: "default" } });
    observe("gate.permission", { decision: decision("c1", "granted", true) });
    observe("gate.permission", { decision: decision("c2", "denied", false) });
    observe("gate.permission", { decision: decision("c3", "denied", true) });
    observe("turn.interrupted", { message: reply("half") });
    observe("engine.error", { error: new Error("the provider hung up") });
    await settled();

    expect(signals).toEqual([
      { kind: "ask", callId: "c1", tool: "write" },
      { kind: "answered", callId: "c1", verdict: "granted" },
      { kind: "answered", callId: "c3", verdict: "denied" },
      { kind: "turn-interrupted", text: "half" },
      { kind: "error", message: "the provider hung up" },
    ]);
  });

  it("ignores replayed events", async () => {
    const { signals, observe, settled } = watching(0.01);
    observe("turn.completed", { message: reply("old"), usage: zero, replay: true });
    await settled();

    expect(signals).toEqual([]);
  });
});

describe("a chore's delivery", () => {
  it("reports the first line of the output to the conversation as the routine thread", async () => {
    const finished: [string, string, ThreadReport][] = [];
    const deliverer = conversationDeliverer({
      finish: async (creature, thread, report) => {
        finished.push([creature, thread, report]);
        return "queued";
      },
    });

    await deliverer.deliver(delivery({ kind: "conversation" }, "\nAll clear.\nThe rest."));

    expect(finished).toEqual([
      ["pip", "s-run", { title: "Morning triage", outcome: "completed", summary: "All clear." }],
    ]);
  });

  it("fails a delivery it cannot make, so the run row says so", async () => {
    const deliverer = conversationDeliverer({ finish: async () => "missing" });

    await expect(deliverer.deliver(delivery({ kind: "conversation" }, "x"))).rejects.toThrow(
      "the conversation of pip could not be opened",
    );
    await expect(
      deliverer.deliver(delivery({ kind: "file", path: "out/today.md" }, "x")),
    ).rejects.toThrow("a file destination is not delivered yet");
  });
});

describe("the creature directory chores read", () => {
  it("homes each creature in its own directory under its own bot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keywork-directory-"));
    const pip = { slug: "pip", dir: join(dir, "pip") } as Creature;
    const directory = creatureDirectoryOver({
      list: async () => [pip],
      read: async (slug) => (slug === "pip" ? pip : undefined),
    });

    expect(await directory.creatures()).toEqual([{ slug: "pip", dir: pip.dir, bot: "pip" }]);
    expect(await directory.creature("pip")).toEqual({ slug: "pip", dir: pip.dir, bot: "pip" });
    expect(await directory.creature("wren")).toBeUndefined();
  });
});

const zero = { inputTokens: 0, outputTokens: 0 };

function watching(costUsd: number | null) {
  const signals: ThreadSignal[] = [];
  const watch = new ThreadWatch(
    async () => costUsd,
    (signal) => signals.push(signal),
  );
  return {
    signals,
    observe: (type: BusEnvelope["type"], payload: unknown) => watch.observe({ type, payload }),
    settled: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

function reply(text: string): Message {
  return { role: "assistant", parts: [{ type: "text", text }] };
}

function decision(callId: string, verdict: "granted" | "denied", asked: boolean) {
  return { tool: "write", callId, verdict, gate: asked ? "user" : "policy", asked };
}

function delivery(destination: Delivery["routine"]["destination"], output: string): Delivery {
  return {
    run: { sessionId: "s-run" } as RunRow,
    routine: { title: "Morning triage", destination } as Delivery["routine"],
    creature: { slug: "pip", dir: "/pip", bot: "pip" },
    output,
  };
}
