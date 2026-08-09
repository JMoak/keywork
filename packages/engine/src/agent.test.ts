import { describe, expect, it } from "vitest";
import { Agent } from "./agent.ts";
import { messageText, textMessage } from "./messages.ts";
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

  it("resolves an already-aborted send as an interrupted turn", async () => {
    const provider = new MockProvider([textTurn("this streams")]);
    const agent = new Agent({ provider });
    const controller = new AbortController();
    controller.abort();
    let interrupted = false;
    agent.bus.on("turn.interrupted", () => {
      interrupted = true;
    });

    const final = await agent.send("anything", controller.signal);

    expect(interrupted).toBe(true);
    expect(final.parts).toEqual([]);
  });

  it("keeps partial output when interrupted mid-stream", async () => {
    const provider = new MockProvider([
      [
        { type: "text", text: "first " },
        { type: "text", text: "second" },
        { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
      ],
    ]);
    const agent = new Agent({ provider });
    agent.bus.on("turn.delta", () => agent.interrupt());
    const events: string[] = [];
    agent.bus.on("turn.interrupted", () => events.push("interrupted"));
    agent.bus.on("turn.completed", () => events.push("completed"));

    const final = await agent.send("go");

    expect(events).toEqual(["interrupted"]);
    expect(messageText(final)).toBe("first ");
    expect(agent.history().at(-1)).toBe(final);
  });

  it("seeds history so a resumed conversation continues in place", async () => {
    const provider = new MockProvider([textTurn("welcome back")]);
    const agent = new Agent({
      provider,
      history: [textMessage("user", "earlier"), textMessage("assistant", "before")],
    });

    await agent.send("again");

    expect(agent.history().map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("accumulates session usage across turns", async () => {
    const provider = new MockProvider([
      textTurn("one", { inputTokens: 10, outputTokens: 2 }),
      textTurn("two", { inputTokens: 20, outputTokens: 3 }),
    ]);
    const agent = new Agent({ provider });

    await agent.send("first");
    await agent.send("second");

    expect(agent.usage()).toEqual({ inputTokens: 30, outputTokens: 5 });
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
