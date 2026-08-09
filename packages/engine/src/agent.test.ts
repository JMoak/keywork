import { describe, expect, it } from "vitest";
import { Agent } from "./agent.ts";
import { messageText } from "./messages.ts";
import { MockProvider, textTurn, toolCallTurn } from "./mock-provider.ts";
import type { Tool } from "./tools.ts";

const echoTool: Tool = {
  name: "echo",
  description: "Repeats its input back.",
  parameters: { type: "object", properties: { text: { type: "string" } } },
  execute: async (args) => `echo: ${(args as { text: string }).text}`,
};

const failingTool: Tool = {
  name: "explode",
  description: "Always fails.",
  parameters: { type: "object" },
  execute: async () => {
    throw new Error("boom");
  },
};

function toolUsingConversation() {
  const provider = new MockProvider([
    toolCallTurn({ type: "tool-call", callId: "call-1", name: "echo", arguments: { text: "hi" } }),
    textTurn("The tool said: echo: hi", { inputTokens: 10, outputTokens: 5 }),
  ]);
  return new Agent({ provider, tools: [echoTool], systemPrompt: "You are keywork." });
}

describe("Agent end-to-end with mock provider", () => {
  it("runs a tool-using conversation to completion", async () => {
    const agent = toolUsingConversation();

    const final = await agent.send("Please echo hi");

    expect(messageText(final)).toBe("The tool said: echo: hi");
    const roles = agent.history().map((message) => message.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("narrates the whole run through bus events", async () => {
    const agent = toolUsingConversation();
    const seen: string[] = [];
    agent.bus.on("turn.started", () => seen.push("turn.started"));
    agent.bus.on("tool.started", ({ call }) => seen.push(`tool.started:${call.name}`));
    agent.bus.on("tool.finished", ({ output }) => seen.push(`tool.finished:${output}`));
    agent.bus.on("turn.completed", ({ usage }) =>
      seen.push(`turn.completed:${usage.outputTokens}`),
    );

    await agent.send("Please echo hi");

    expect(seen).toEqual([
      "turn.started",
      "tool.started:echo",
      "tool.finished:echo: hi",
      "turn.completed:5",
    ]);
  });

  it("feeds tool failures back to the model instead of crashing", async () => {
    const provider = new MockProvider([
      toolCallTurn({ type: "tool-call", callId: "call-1", name: "explode", arguments: {} }),
      textTurn("That tool failed."),
    ]);
    const agent = new Agent({ provider, tools: [failingTool] });

    const final = await agent.send("Try the tool");

    expect(messageText(final)).toBe("That tool failed.");
    const toolResult = agent.history()[2]?.parts[0];
    expect(toolResult).toMatchObject({ type: "tool-result", output: "boom", isError: true });
  });

  it("reports unknown tools as errored results", async () => {
    const provider = new MockProvider([
      toolCallTurn({ type: "tool-call", callId: "call-1", name: "missing", arguments: {} }),
      textTurn("No such tool."),
    ]);
    const agent = new Agent({ provider, tools: [echoTool] });

    await agent.send("Use a missing tool");

    const toolResult = agent.history()[2]?.parts[0];
    expect(toolResult).toMatchObject({ isError: true, output: "Unknown tool: missing" });
  });

  it("aborts mid-stream when steered", async () => {
    const provider = new MockProvider([textTurn("this streams")]);
    const agent = new Agent({ provider });
    const controller = new AbortController();
    controller.abort();

    await expect(agent.send("anything", controller.signal)).rejects.toThrow();
  });

  it("accumulates streamed text into one part", async () => {
    const provider = new MockProvider([
      [
        { type: "text", text: "Hello " },
        { type: "text", text: "world" },
        { type: "done", usage: { inputTokens: 1, outputTokens: 2 } },
      ],
    ]);
    const agent = new Agent({ provider });

    const final = await agent.send("hi");

    expect(final.parts).toHaveLength(1);
    expect(messageText(final)).toBe("Hello world");
  });
});
