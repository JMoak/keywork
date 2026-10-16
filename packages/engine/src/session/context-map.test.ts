import { describe, expect, it } from "vitest";
import { Agent } from "../agent.ts";
import { textMessage } from "../messages.ts";
import { MockProvider, textTurn, toolCallTurn } from "../mock-provider.ts";
import type { Tool } from "../tools.ts";
import { estimateConversationTokens, estimateTextTokens } from "./compaction.ts";
import { contextBudgetFor, readContext } from "./context-budget.ts";
import { contextMapOf, type RequestAnatomy, readAgentContext } from "./context-map.ts";

const budget = contextBudgetFor(1_000);

const echo: Tool = {
  name: "echo",
  description: "Repeats its input.",
  parameters: { type: "object" },
  execute: async () => "echo",
};

const echoTokens = estimateTextTokens(
  JSON.stringify({ name: echo.name, description: echo.description, parameters: echo.parameters }),
);

function anatomyOf(overrides: Partial<RequestAnatomy> = {}): RequestAnatomy {
  return {
    systemPrompt: "k".repeat(400),
    injected: ["m".repeat(120)],
    tools: [echo],
    history: [textMessage("user", "u".repeat(200))],
    reported: undefined,
    ...overrides,
  };
}

describe("contextMapOf", () => {
  it("splits the request into its parts from the text when nothing was reported", () => {
    const anatomy = anatomyOf();
    const conversation = estimateConversationTokens(anatomy.history);
    const reading = readContext(conversation, budget);
    const map = contextMapOf(anatomy, reading);
    expect(map.parts).toEqual({
      system: { tokens: 70, basis: "estimated" },
      tools: { tokens: echoTokens, basis: "estimated" },
      injected: { tokens: 30, basis: "estimated" },
      conversation: { tokens: conversation, basis: "estimated" },
      free: { tokens: 1_000 - 100 - echoTokens - conversation, basis: "estimated" },
    });
    expect(map.thresholds).toEqual({
      flushAt: reading.flushAt + 100 + echoTokens,
      compactAt: reading.compactAt + 100 + echoTokens,
    });
  });

  it("rests the conversation on the provider's reported total plus what arrived since", () => {
    const history = [
      textMessage("user", "u".repeat(200)),
      textMessage("assistant", "a".repeat(40)),
    ];
    const later = textMessage("user", "n".repeat(80));
    const anatomy = anatomyOf({
      history: [...history, later],
      reported: { tokens: 600, messages: history.length },
    });
    const reading = readContext(estimateConversationTokens(anatomy.history), budget);
    const map = contextMapOf(anatomy, reading);
    const since = estimateConversationTokens([later]);
    const conversation = 600 - 100 - echoTokens + since;
    expect(map.parts.conversation).toEqual({ tokens: conversation, basis: "reported" });
    expect(map.parts.free).toEqual({ tokens: 1_000 - 600 - since, basis: "reported" });
    expect(map.parts.system.basis).toBe("estimated");
    const filled = 600 + since;
    expect(map.thresholds.compactAt).toBe(reading.compactAt + filled - reading.used);
  });

  it("falls back to the text when the reported request covered more than the history holds", () => {
    const anatomy = anatomyOf({ reported: { tokens: 600, messages: 5 } });
    const map = contextMapOf(anatomy, readContext(0, budget));
    expect(map.parts.conversation.basis).toBe("estimated");
  });

  it("caps the injected part at the prompt it rides in", () => {
    const anatomy = anatomyOf({ systemPrompt: "short", injected: ["x".repeat(400)] });
    const map = contextMapOf(anatomy, readContext(0, budget));
    expect(map.parts.injected.tokens).toBe(estimateTextTokens("short"));
    expect(map.parts.system.tokens).toBe(0);
  });
});

describe("readAgentContext", () => {
  it("anchors on the usage of the agent's last request and counts extension context as injected", async () => {
    const provider = new MockProvider([
      textTurn("hi", { inputTokens: 300, outputTokens: 20, cacheReadInputTokens: 100 }),
    ]);
    const agent = new Agent({
      provider,
      systemPrompt: "core\n\nAGENTS.md text",
      promptInjections: ["AGENTS.md text"],
      tools: [echo],
      hooks: { systemPrompt: async (base) => `${base}\n\nextension context` },
    });
    expect(readAgentContext(agent, budget).parts.conversation.basis).toBe("estimated");

    await agent.send("hello");

    expect(agent.anatomy().reported).toEqual({ tokens: 420, messages: 2 });
    const context = readAgentContext(agent, budget);
    expect(context.used).toBe(estimateConversationTokens(agent.history()));
    expect(context.parts.conversation.basis).toBe("reported");
    expect(context.parts.injected.tokens).toBe(
      estimateTextTokens("AGENTS.md text") + estimateTextTokens("\n\nextension context"),
    );
  });

  it("forgets the anchor once settling rewrites the history", async () => {
    const provider = new MockProvider([
      toolCallTurn(
        { type: "tool-call", callId: "c1", name: "echo", arguments: {} },
        { inputTokens: 50, outputTokens: 5 },
      ),
      textTurn("done"),
    ]);
    const agent = new Agent({ provider, tools: [echo] });
    agent.settleToolBatchesWith(async (history) => history.slice(-1));

    await agent.send("go");

    expect(agent.anatomy().reported).toBeUndefined();
    expect(readAgentContext(agent, budget).parts.conversation.basis).toBe("estimated");
  });
});
