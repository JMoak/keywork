import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "./agent.ts";
import type { Usage } from "./messages.ts";
import { MockProvider, textTurn, toolCallTurn } from "./mock-provider.ts";
import {
  costNanosOf,
  emptyCostRollup,
  formatCostNanos,
  groupCosts,
  knownCostNanos,
  mergeCostRollups,
  ratesFor,
  sessionCost,
  withTurnCost,
} from "./pricing.ts";
import type { MessageEntry, ModelChangeEntry } from "./session/entries.ts";
import { SessionStore } from "./session/store.ts";

const tokens = (inputTokens: number, outputTokens: number, extra: Partial<Usage> = {}): Usage => ({
  inputTokens,
  outputTokens,
  ...extra,
});

describe("costNanosOf", () => {
  it("prices input and output at the model's listed rates", () => {
    expect(costNanosOf(tokens(1_000_000, 1_000_000), "gpt-5-mini")).toBe(2_250_000_000);
  });

  it("returns undefined for an unknown model instead of pricing it free", () => {
    expect(costNanosOf(tokens(500, 500), "somebody/mystery-model")).toBeUndefined();
    expect(costNanosOf(tokens(500, 500), undefined)).toBeUndefined();
  });

  it("prices cache reads at the discounted rate, far below naive input math", () => {
    const cacheHeavy = tokens(0, 0, { cacheReadInputTokens: 1_000_000 });
    expect(costNanosOf(cacheHeavy, "gpt-5-mini")).toBe(25_000_000);
    expect(costNanosOf(tokens(1_000_000, 0), "gpt-5-mini")).toBe(250_000_000);
  });

  it("prices cache writes at the input rate when no premium is listed", () => {
    const writeHeavy = tokens(0, 0, { cacheCreationInputTokens: 1_000_000 });
    expect(costNanosOf(writeHeavy, "amazon.nova-lite-v1:0")).toBe(60_000_000);
  });

  it("prefers the provider-metered cost over table math", () => {
    const metered = tokens(1_000_000, 1_000_000, { costUsd: 0.5 });
    expect(costNanosOf(metered, "gpt-5-mini")).toBe(500_000_000);
  });

  it("accepts a metered cost even for a model missing from the table", () => {
    expect(costNanosOf(tokens(10, 10, { costUsd: 0.001 }), "mystery")).toBe(1_000_000);
  });

  it("prices a zero-usage turn at zero for a known model", () => {
    expect(costNanosOf(tokens(0, 0), "gpt-5-nano")).toBe(0);
  });
});

describe("ratesFor", () => {
  it("normalizes gateway prefixes, bedrock geo prefixes, and date suffixes", () => {
    const bare = ratesFor("gpt-5-mini");
    expect(bare).toBeDefined();
    expect(ratesFor("openai/gpt-5-mini")).toEqual(bare);
    expect(ratesFor("gpt-5-mini-2025-08-07")).toEqual(bare);
    expect(ratesFor("us.amazon.nova-lite-v1:0")).toEqual(ratesFor("amazon.nova-lite-v1:0"));
  });

  it("covers no anthropic models before workstream G", () => {
    expect(ratesFor("claude-anything")).toBeUndefined();
  });
});

describe("withTurnCost", () => {
  it("stays exact across many tiny turns", () => {
    let rollup = emptyCostRollup();
    for (let turn = 0; turn < 100_000; turn += 1) {
      rollup = withTurnCost(rollup, tokens(3, 1), "gpt-5-nano");
    }
    expect(rollup.nanos).toBe(55_000_000);
    expect(rollup.pricedTurns).toBe(100_000);
    expect(formatCostNanos(rollup.nanos)).toBe("$0.055");
  });

  it("counts unknown-model turns as unpriced, never as free", () => {
    const rollup = withTurnCost(emptyCostRollup(), tokens(10, 10), undefined);
    expect(rollup).toEqual({ nanos: 0, pricedTurns: 0, meteredTurns: 0, unpricedTurns: 1 });
    expect(knownCostNanos(rollup)).toBeUndefined();
  });

  it("skips turns that carry no usage at all", () => {
    expect(withTurnCost(emptyCostRollup(), tokens(0, 0), undefined)).toEqual(emptyCostRollup());
  });

  it("tallies metered turns separately from estimated ones", () => {
    let rollup = withTurnCost(emptyCostRollup(), tokens(10, 10, { costUsd: 0.01 }), undefined);
    rollup = withTurnCost(rollup, tokens(10, 10), "gpt-5-mini");
    expect(rollup.pricedTurns).toBe(2);
    expect(rollup.meteredTurns).toBe(1);
  });
});

describe("formatCostNanos", () => {
  it("renders compact dollars", () => {
    expect(formatCostNanos(4_200_000)).toBe("$0.0042");
    expect(formatCostNanos(50_000_000)).toBe("$0.05");
    expect(formatCostNanos(0)).toBe("$0.00");
    expect(formatCostNanos(1_234_567_890)).toBe("$1.23");
    expect(formatCostNanos(123_400_000)).toBe("$0.1234");
  });
});

describe("sessionCost", () => {
  it("derives cost from persisted usage, honoring model changes mid-session", () => {
    const entries = [
      messageEntry("a", tokens(1_000_000, 0)),
      modelChangeEntry("b", "gpt-5"),
      messageEntry("c", tokens(1_000_000, 0)),
    ];
    const rollup = sessionCost(entries, "gpt-5-mini");
    expect(rollup.nanos).toBe(1_500_000_000);
    expect(knownCostNanos(rollup)).toBe(1_500_000_000);
  });

  it("reports unpriced turns when no model is on record", () => {
    const rollup = sessionCost([messageEntry("a", tokens(5, 5))]);
    expect(rollup.unpricedTurns).toBe(1);
    expect(knownCostNanos(rollup)).toBeUndefined();
  });

  it("prices metered usage without needing any model on record", () => {
    const rollup = sessionCost([messageEntry("a", tokens(5, 5, { costUsd: 0.002 }))]);
    expect(knownCostNanos(rollup)).toBe(2_000_000);
    expect(rollup.meteredTurns).toBe(1);
  });

  it("returns an empty rollup for a session with no usage", () => {
    expect(sessionCost([messageEntry("a")])).toEqual(emptyCostRollup());
  });
});

describe("groupCosts", () => {
  it("rolls sessions up under an injectable grouping key", () => {
    const first = [messageEntry("a", tokens(5, 5, { costUsd: 0.001 }))];
    const second = [messageEntry("b", tokens(5, 5, { costUsd: 0.002 }))];
    const third = [messageEntry("c", tokens(5, 5, { costUsd: 0.004 }))];
    const grouped = groupCosts(
      [
        { sessionId: "s1", entries: first },
        { sessionId: "s2", entries: second },
        { sessionId: "s3", entries: third },
      ],
      (sessionId) => (sessionId === "s3" ? "solo" : "paired"),
    );
    expect(knownCostNanos(grouped.get("paired") ?? emptyCostRollup())).toBe(3_000_000);
    expect(knownCostNanos(grouped.get("solo") ?? emptyCostRollup())).toBe(4_000_000);
  });
});

describe("mergeCostRollups", () => {
  it("adds every counter", () => {
    const left = { nanos: 10, pricedTurns: 1, meteredTurns: 1, unpricedTurns: 0 };
    const right = { nanos: 5, pricedTurns: 2, meteredTurns: 0, unpricedTurns: 3 };
    expect(mergeCostRollups(left, right)).toEqual({
      nanos: 15,
      pricedTurns: 3,
      meteredTurns: 1,
      unpricedTurns: 3,
    });
  });
});

describe("Agent cost accounting", () => {
  it("accumulates cost across every segment of a tool-calling turn", async () => {
    const call = {
      type: "tool-call" as const,
      callId: "1",
      name: "noop",
      arguments: {},
    };
    const provider = new MockProvider(
      [toolCallTurn(call, tokens(100, 10)), textTurn("done", tokens(200, 20))],
      "gpt-5-mini",
    );
    const agent = new Agent({
      provider,
      tools: [{ name: "noop", description: "", parameters: {}, execute: async () => "ok" }],
    });
    await agent.send("go");
    expect(agent.cost()).toEqual({
      nanos: 100 * 250 + 10 * 2000 + 200 * 250 + 20 * 2000,
      pricedTurns: 2,
      meteredTurns: 0,
      unpricedTurns: 0,
    });
    expect(agent.modelId()).toBe("gpt-5-mini");
  });

  it("keeps cost unknown when the provider has no model on record", async () => {
    const agent = new Agent({ provider: new MockProvider([textTurn("hi", tokens(5, 5))]) });
    await agent.send("go");
    expect(agent.cost().unpricedTurns).toBe(1);
    expect(knownCostNanos(agent.cost())).toBeUndefined();
  });

  it("still counts the turn when the stream is interrupted mid-tool-loop", async () => {
    const call = {
      type: "tool-call" as const,
      callId: "1",
      name: "noop",
      arguments: {},
    };
    const provider = new MockProvider([toolCallTurn(call, tokens(50, 5))], "gpt-5-mini");
    const agent = new Agent({
      provider,
      tools: [
        {
          name: "noop",
          description: "",
          parameters: {},
          execute: async () => {
            agent.interrupt();
            return "ok";
          },
        },
      ],
    });
    await agent.send("go");
    expect(agent.cost().pricedTurns).toBe(1);
    expect(agent.cost().nanos).toBe(50 * 250 + 5 * 2000);
  });

  it("sums cache tokens and metered cost into usage totals", async () => {
    const usage = tokens(10, 5, {
      cacheReadInputTokens: 40,
      cacheCreationInputTokens: 8,
      costUsd: 0.003,
    });
    const agent = new Agent({
      provider: new MockProvider([textTurn("a", usage), textTurn("b", usage)]),
    });
    await agent.send("one");
    await agent.send("two");
    expect(agent.usage()).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 16,
      costUsd: 0.006,
    });
    expect(agent.cost()).toEqual({
      nanos: 6_000_000,
      pricedTurns: 2,
      meteredTurns: 2,
      unpricedTurns: 0,
    });
  });
});

describe("SessionStore cost stats", () => {
  const scratchDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function scratchDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "keywork-pricing-"));
    scratchDirs.push(dir);
    return dir;
  }

  it("derives a metered session cost on read", async () => {
    const dir = await scratchDir();
    const store = await SessionStore.create(join(dir, "s.jsonl"), dir);
    await store.append(
      { role: "assistant", parts: [{ type: "text", text: "hi" }] },
      tokens(10, 5, { costUsd: 0.0042 }),
    );
    const reopened = await SessionStore.open(store.file);
    expect(knownCostNanos(reopened.stats().cost)).toBe(4_200_000);
  });

  it("keeps an unmetered session's cost unknown when no model is on record", async () => {
    const dir = await scratchDir();
    const store = await SessionStore.create(join(dir, "s.jsonl"), dir);
    await store.append({ role: "assistant", parts: [] }, tokens(10, 5));
    expect(knownCostNanos(store.stats().cost)).toBeUndefined();
    expect(store.stats().cost.unpricedTurns).toBe(1);
  });
});

function messageEntry(id: string, usage?: Usage): MessageEntry {
  return {
    id,
    parentId: null,
    timestamp: "",
    type: "message",
    message: { role: "assistant", parts: [] },
    ...(usage !== undefined && { usage }),
  };
}

function modelChangeEntry(id: string, modelId: string): ModelChangeEntry {
  return { id, parentId: null, timestamp: "", type: "model_change", provider: "test", modelId };
}
