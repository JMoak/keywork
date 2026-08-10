import { describe, expect, it } from "vitest";
import { Agent, AgentBusyError } from "./agent.ts";
import { type Message, messageText, textMessage, toolCalls } from "./messages.ts";
import { MockProvider, textTurn, toolCallTurn } from "./mock-provider.ts";
import type { Provider, TurnDelta } from "./provider.ts";
import type { Tool } from "./tools.ts";

async function* streamOf(deltas: TurnDelta[]): AsyncIterable<TurnDelta> {
  yield* deltas;
}

async function* hangUntilAborted(signal?: AbortSignal): AsyncIterable<TurnDelta> {
  await new Promise((_, reject) => {
    const abort = () => reject(new Error("aborted"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
  yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
}

function orphanedCallIds(history: readonly Message[]): string[] {
  const settled = new Set(
    history
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool-result")
      .map((part) => part.callId),
  );
  return history
    .flatMap((message) => toolCalls(message))
    .map((call) => call.callId)
    .filter((callId) => !settled.has(callId));
}

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

  it("asks the guard before running a mutating tool and reports declines", async () => {
    const executed: string[] = [];
    const mutatingTool: Tool = {
      ...echoTool,
      name: "scribble",
      mutates: true,
      execute: async () => {
        executed.push("scribble");
        return "wrote";
      },
    };
    const provider = new MockProvider([
      toolCallTurn({ type: "tool-call", callId: "call-1", name: "scribble", arguments: {} }),
      textTurn("Understood."),
    ]);
    const agent = new Agent({
      provider,
      tools: [mutatingTool],
      guard: { confirm: async () => false },
    });

    await agent.send("Change something");

    expect(executed).toEqual([]);
    const toolResult = agent.history()[2]?.parts[0];
    expect(toolResult).toMatchObject({ isError: true, output: "declined by user" });
  });

  it("checkpoints once per send, before the first mutating tool only", async () => {
    const order: string[] = [];
    const mutatingTool: Tool = {
      ...echoTool,
      name: "scribble",
      mutates: true,
      execute: async () => {
        order.push("execute");
        return "wrote";
      },
    };
    const mutatingCall = (callId: string) =>
      toolCallTurn({ type: "tool-call", callId, name: "scribble", arguments: {} });
    const provider = new MockProvider([
      mutatingCall("call-1"),
      mutatingCall("call-2"),
      textTurn("Done."),
      mutatingCall("call-3"),
      textTurn("Done again."),
    ]);
    const agent = new Agent({
      provider,
      tools: [mutatingTool],
      guard: {
        beforeMutation: async () => {
          order.push("checkpoint");
        },
      },
    });

    await agent.send("Change things twice");
    await agent.send("Change once more");

    expect(order).toEqual(["checkpoint", "execute", "execute", "checkpoint", "execute"]);
  });

  it("leaves non-mutating tools unguarded", async () => {
    const guardCalls: string[] = [];
    const agent = new Agent({
      provider: new MockProvider([
        toolCallTurn({
          type: "tool-call",
          callId: "call-1",
          name: "echo",
          arguments: { text: "hi" },
        }),
        textTurn("Echoed."),
      ]),
      tools: [echoTool],
      guard: {
        confirm: async (call) => {
          guardCalls.push(call.name);
          return true;
        },
        beforeMutation: async () => {
          guardCalls.push("checkpoint");
        },
      },
    });

    await agent.send("Just echo");

    expect(guardCalls).toEqual([]);
    expect(agent.history()[2]?.parts[0]).toMatchObject({ output: "echo: hi", isError: false });
  });

  it("denies a tool by permission verdict without consulting the guard", async () => {
    const executed: string[] = [];
    const guardCalls: string[] = [];
    const mutatingTool: Tool = {
      ...echoTool,
      name: "scribble",
      mutates: true,
      execute: async () => {
        executed.push("scribble");
        return "wrote";
      },
    };
    const agent = new Agent({
      provider: new MockProvider([
        toolCallTurn({ type: "tool-call", callId: "call-1", name: "scribble", arguments: {} }),
        textTurn("Understood."),
      ]),
      tools: [mutatingTool],
      guard: {
        confirm: async (call) => {
          guardCalls.push(call.name);
          return true;
        },
      },
      permissions: () => "deny",
    });

    await agent.send("Change something");

    expect(executed).toEqual([]);
    expect(guardCalls).toEqual([]);
    expect(agent.history()[2]?.parts[0]).toMatchObject({
      isError: true,
      output: "denied by permission policy",
    });
  });

  it("denies non-mutating tools too when the policy says so", async () => {
    const agent = new Agent({
      provider: new MockProvider([
        toolCallTurn({
          type: "tool-call",
          callId: "call-1",
          name: "echo",
          arguments: { text: "x" },
        }),
        textTurn("Understood."),
      ]),
      tools: [echoTool],
      permissions: (call) => (call.name === "echo" ? "deny" : undefined),
    });

    await agent.send("Read something");

    expect(agent.history()[2]?.parts[0]).toMatchObject({
      isError: true,
      output: "denied by permission policy",
    });
  });

  it("skips the ask but still checkpoints when the policy allows a mutation", async () => {
    const order: string[] = [];
    const mutatingTool: Tool = {
      ...echoTool,
      name: "scribble",
      mutates: true,
      execute: async () => {
        order.push("execute");
        return "wrote";
      },
    };
    const agent = new Agent({
      provider: new MockProvider([
        toolCallTurn({ type: "tool-call", callId: "call-1", name: "scribble", arguments: {} }),
        textTurn("Done."),
      ]),
      tools: [mutatingTool],
      guard: {
        confirm: async () => {
          order.push("confirm");
          return false;
        },
        beforeMutation: async () => {
          order.push("checkpoint");
        },
      },
      permissions: () => "allow",
    });

    await agent.send("Change something");

    expect(order).toEqual(["checkpoint", "execute"]);
  });

  it("asks the guard when the policy says ask, even for non-mutating tools", async () => {
    const guardCalls: string[] = [];
    const agent = new Agent({
      provider: new MockProvider([
        toolCallTurn({
          type: "tool-call",
          callId: "call-1",
          name: "echo",
          arguments: { text: "x" },
        }),
        textTurn("Understood."),
      ]),
      tools: [echoTool],
      guard: {
        confirm: async (call) => {
          guardCalls.push(call.name);
          return false;
        },
      },
      permissions: () => "ask",
    });

    await agent.send("Read carefully");

    expect(guardCalls).toEqual(["echo"]);
    expect(agent.history()[2]?.parts[0]).toMatchObject({
      isError: true,
      output: "declined by user",
    });
  });

  it("falls back to the mutates default where the policy is silent", async () => {
    const guardCalls: string[] = [];
    const mutatingTool: Tool = {
      ...echoTool,
      name: "scribble",
      mutates: true,
      execute: async () => "wrote",
    };
    const agent = new Agent({
      provider: new MockProvider([
        toolCallTurn({
          type: "tool-call",
          callId: "call-1",
          name: "echo",
          arguments: { text: "x" },
        }),
        toolCallTurn({ type: "tool-call", callId: "call-2", name: "scribble", arguments: {} }),
        textTurn("Done."),
      ]),
      tools: [echoTool, mutatingTool],
      guard: {
        confirm: async (call) => {
          guardCalls.push(call.name);
          return true;
        },
      },
      permissions: () => undefined,
    });

    await agent.send("Mixed work");

    expect(guardCalls).toEqual(["scribble"]);
  });

  it("keeps interrupt aimed at a turn started from a completion event", async () => {
    let calls = 0;
    const provider: Provider = {
      name: "two-phase",
      stream: (request) =>
        calls++ === 0 ? streamOf(textTurn("first")) : hangUntilAborted(request.signal),
    };
    const agent = new Agent({ provider });
    let queued: Promise<unknown> | undefined;
    agent.bus.on("turn.completed", () => {
      queued ??= agent.send("queued");
    });
    const events: string[] = [];
    agent.bus.on("turn.interrupted", () => events.push("interrupted"));

    await agent.send("go");
    agent.interrupt();
    await queued;

    expect(events).toEqual(["interrupted"]);
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

  it("repairs history after an interrupt between tool calls so the next send succeeds", async () => {
    const call = (callId: string): TurnDelta => ({
      type: "tool-call",
      call: { type: "tool-call", callId, name: "echo", arguments: { text: callId } },
    });
    const provider = new MockProvider([
      [
        call("call-1"),
        call("call-2"),
        { type: "done", usage: { inputTokens: 5, outputTokens: 2 } },
      ],
      textTurn("recovered"),
    ]);
    const agent = new Agent({ provider, tools: [echoTool] });
    agent.bus.on("tool.started", () => agent.interrupt());

    await agent.send("go");

    expect(orphanedCallIds(agent.history())).toEqual([]);
    expect(agent.history().at(-1)?.parts[0]).toMatchObject({
      type: "tool-result",
      callId: "call-2",
      output: "interrupted before execution",
      isError: true,
    });
    expect(agent.usage()).toEqual({ inputTokens: 5, outputTokens: 2 });

    const final = await agent.send("carry on");
    expect(messageText(final)).toBe("recovered");
    expect(orphanedCallIds(agent.history())).toEqual([]);
  });

  it("repairs history after an interrupt mid-stream leaves an unexecuted tool call", async () => {
    const provider = new MockProvider([
      toolCallTurn({ type: "tool-call", callId: "call-1", name: "echo", arguments: { text: "x" } }),
      textTurn("recovered"),
    ]);
    const agent = new Agent({ provider, tools: [echoTool] });
    agent.bus.on("turn.delta", () => agent.interrupt());

    await agent.send("go");

    expect(orphanedCallIds(agent.history())).toEqual([]);
    expect(agent.history().at(-1)?.parts[0]).toMatchObject({
      type: "tool-result",
      callId: "call-1",
      output: "interrupted before execution",
      isError: true,
    });

    const final = await agent.send("carry on");
    expect(messageText(final)).toBe("recovered");
  });

  it("rejects a send while a turn is in flight and frees up once it settles", async () => {
    let calls = 0;
    const provider: Provider = {
      name: "two-phase",
      stream: (request) =>
        calls++ === 0 ? hangUntilAborted(request.signal) : streamOf(textTurn("free again")),
    };
    const agent = new Agent({ provider });

    const first = agent.send("one");
    expect(agent.busy()).toBe(true);
    await expect(agent.send("two")).rejects.toBeInstanceOf(AgentBusyError);
    expect(agent.history().filter((message) => message.role === "user")).toHaveLength(1);

    agent.interrupt();
    await first;
    expect(agent.busy()).toBe(false);
    expect(messageText(await agent.send("three"))).toBe("free again");
  });

  it("keeps usage the provider delivered before a stream failure", async () => {
    const provider: Provider = {
      name: "flaky",
      async *stream(): AsyncGenerator<TurnDelta> {
        yield { type: "text", text: "partial" };
        yield { type: "done", usage: { inputTokens: 7, outputTokens: 3 } };
        throw new Error("wire dropped");
      },
    };
    const agent = new Agent({ provider });

    await expect(agent.send("go")).rejects.toThrow("wire dropped");

    expect(agent.usage()).toEqual({ inputTokens: 7, outputTokens: 3 });
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
