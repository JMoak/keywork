import { Agent, MockProvider, textTurn } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { SessionLedger } from "./session-ledger.ts";

async function spent(
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd?: number;
    cacheReadInputTokens?: number;
  },
  modelId?: string,
): Promise<Agent> {
  const agent = new Agent({ provider: new MockProvider([textTurn("hi", usage)], modelId ?? {}) });
  await agent.send("go");
  return agent;
}

describe("SessionLedger usage", () => {
  it("shows dollars in the usage summary once every turn is priced", async () => {
    const agent = await spent({ inputTokens: 10_000, outputTokens: 1_000 }, "gpt-5-mini");
    expect(new SessionLedger().usageSummary(agent)).toBe("$0.0045");
  });

  it("keeps showing raw token counts when the model has no pricing", async () => {
    const agent = await spent({ inputTokens: 3, outputTokens: 2 });
    expect(new SessionLedger().usageSummary(agent)).toBe("3▸2");
  });

  it("prefers the provider-metered cost over table estimates", async () => {
    const agent = await spent(
      { inputTokens: 10_000, outputTokens: 1_000, costUsd: 0.9 },
      "gpt-5-mini",
    );
    expect(new SessionLedger().usageSummary(agent)).toBe("$0.90");
  });

  it("stays blank before any usage lands and without an agent", () => {
    const ledger = new SessionLedger();
    expect(ledger.usageSummary(new Agent({ provider: new MockProvider([]) }))).toBe("");
    expect(ledger.usageSummary(undefined)).toBe("");
  });
});

describe("SessionLedger cost report", () => {
  it("says there is nothing to price on a fresh session", () => {
    const ledger = new SessionLedger();
    expect(ledger.costReport(new Agent({ provider: new MockProvider([]) }))).toBe(
      "no usage yet · send a prompt first",
    );
    expect(ledger.costReport(undefined)).toBe("no provider · nothing to meter");
  });

  it("prints tokens plus an estimated total for a priced model", async () => {
    const agent = await spent(
      { inputTokens: 10_000, outputTokens: 1_000, cacheReadInputTokens: 500 },
      "gpt-5-mini",
    );
    expect(new SessionLedger().costReport(agent)).toBe(
      "tokens 10000▸1000 · cache read 500\ncost $0.0045 · estimated from gpt-5-mini rates",
    );
  });

  it("admits when a model has no pricing instead of claiming zero", async () => {
    const agent = await spent({ inputTokens: 7, outputTokens: 3 });
    expect(new SessionLedger().costReport(agent)).toBe(
      "tokens 7▸3\ncost unknown · no pricing for this model",
    );
  });

  it("labels a fully provider-metered total as metered", async () => {
    const agent = await spent({ inputTokens: 5, outputTokens: 5, costUsd: 0.002 });
    expect(new SessionLedger().costReport(agent)).toBe(
      "tokens 5▸5\ncost $0.002 · metered by the provider",
    );
  });

  it("carries retired agents' totals and attributes them per model", async () => {
    const ledger = new SessionLedger();
    const first = new Agent({
      provider: new MockProvider([textTurn("a", { inputTokens: 10_000, outputTokens: 1_000 })], {
        modelId: "gpt-5-mini",
      }),
    });
    await first.send("one");
    ledger.retire(first);
    const second = new Agent({
      provider: new MockProvider([textTurn("b", { inputTokens: 2_000, outputTokens: 100 })], {
        modelId: "gpt-5",
      }),
    });
    expect(ledger.usageSummary(second)).toBe("$0.0045");
    await second.send("two");
    expect(ledger.costReport(second)).toBe(
      [
        "tokens 12000▸1100",
        "cost $0.008 · estimated from gpt-5 rates",
        "  mock/gpt-5-mini · 1 turn · 10000▸1000 · $0.0045",
        "  mock/gpt-5 · 1 turn · 2000▸100 · $0.0035",
      ].join("\n"),
    );
  });
});

describe("SessionLedger context", () => {
  it("reads the context off the live agent against its declared window and caches it", async () => {
    const agent = new Agent({
      provider: new MockProvider([textTurn("a reply of some length")], {
        capabilities: { input: ["text"], toolCalls: true, contextWindow: 8_000 },
      }),
    });
    const ledger = new SessionLedger();
    expect(ledger.contextReading(agent)).toMatchObject({ used: 0, window: 8_000, declared: true });
    await agent.send("hello there");
    const reading = ledger.contextReading(agent);
    expect(reading?.used).toBeGreaterThan(0);
    expect(reading).toMatchObject({ window: 8_000, flushAt: 7_000, compactAt: 7_334 });
    expect(ledger.contextReading(agent)).toBe(reading);
  });

  it("prints the readout, assuming the window when none is declared", async () => {
    const agent = new Agent({ provider: new MockProvider([textTurn("hi")]) });
    await agent.send("go");
    const text = new SessionLedger().contextReport(agent);
    expect(text).toMatch(/^context \d+ of 200000 tokens · estimated from the conversation text\n/);
    expect(text).toContain("memory flush at 175424 · compaction at 183616");
    expect(text).toContain("window assumed at 200000");
    expect(new SessionLedger().contextReport(undefined)).toBe("no provider · nothing to measure");
  });

  it("keeps the session identity the pane and app agree on", () => {
    const ledger = new SessionLedger();
    expect(ledger.sessionId).toBeUndefined();
    ledger.sessionId = "s1";
    ledger.arc = "auth";
    expect([ledger.sessionId, ledger.arc]).toEqual(["s1", "auth"]);
  });
});
