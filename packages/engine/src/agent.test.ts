import { describe, expect, it } from "vitest";
import { Agent, QueuedPromptCancelledError } from "./agent.ts";
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

  it("runs point-of-action recall on mutating calls and appends it to the result", async () => {
    const mutatingEcho: Tool = { ...echoTool, mutates: true };
    const provider = new MockProvider([
      toolCallTurn({
        type: "tool-call",
        callId: "call-1",
        name: "echo",
        arguments: { text: "hi" },
      }),
      textTurn("done"),
    ]);
    const recalled: string[] = [];
    const agent = new Agent({
      provider,
      tools: [mutatingEcho],
      guard: { confirm: async () => true },
      actionRecall: async (call) => {
        recalled.push(call.name);
        return "## memory for hi\n\n### [[Echo Rule]]\n\nkeep echoes short\n\nretrieval: lexical";
      },
    });

    await agent.send("echo please");

    expect(recalled).toEqual(["echo"]);
    const toolResult = agent.history()[2]?.parts[0];
    expect(toolResult).toMatchObject({
      type: "tool-result",
      output:
        "echo: hi\n\n## memory for hi\n\n### [[Echo Rule]]\n\nkeep echoes short\n\nretrieval: lexical",
      isError: false,
    });
  });

  it("leaves non-mutating calls and silent recalls untouched", async () => {
    const provider = new MockProvider([
      toolCallTurn({
        type: "tool-call",
        callId: "call-1",
        name: "echo",
        arguments: { text: "hi" },
      }),
      textTurn("done"),
    ]);
    let consulted = 0;
    const agent = new Agent({
      provider,
      tools: [echoTool],
      actionRecall: async () => {
        consulted += 1;
        return undefined;
      },
    });

    await agent.send("echo please");

    expect(consulted).toBe(0);
    expect(agent.history()[2]?.parts[0]).toMatchObject({ output: "echo: hi" });
  });

  it("appends nothing when the recall stays silent on a mutating call", async () => {
    const mutatingEcho: Tool = { ...echoTool, mutates: true };
    const provider = new MockProvider([
      toolCallTurn({
        type: "tool-call",
        callId: "call-1",
        name: "echo",
        arguments: { text: "hi" },
      }),
      textTurn("done"),
    ]);
    const agent = new Agent({
      provider,
      tools: [mutatingEcho],
      guard: { confirm: async () => true },
      actionRecall: async () => undefined,
    });

    await agent.send("echo please");

    expect(agent.history()[2]?.parts[0]).toMatchObject({ output: "echo: hi" });
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

    const final = await agent.send("anything", { signal: controller.signal });

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

  it("labels a guard-answered ask with the guard's gate", async () => {
    const mutatingTool: Tool = { ...echoTool, name: "scribble", mutates: true };
    const provider = new MockProvider([
      toolCallTurn({ type: "tool-call", callId: "call-1", name: "scribble", arguments: {} }),
      textTurn("Understood."),
    ]);
    const agent = new Agent({
      provider,
      tools: [mutatingTool],
      guard: { confirm: async () => false, gate: "headless" },
    });
    const gates: string[] = [];
    agent.bus.on("gate.permission", ({ decision }) =>
      gates.push(`${decision.verdict}:${decision.gate}`),
    );

    await agent.send("Change something");

    expect(gates).toEqual(["denied:headless"]);
  });

  it("announces standing injections once, before the first turn, after subscribers attach", async () => {
    const provider = new MockProvider([textTurn("one"), textTurn("two")]);
    const agent = new Agent({
      provider,
      standingInjections: [
        { source: "project-instructions", id: "AGENTS.md" },
        { source: "memory-bootstrap", scope: "workspace" },
      ],
    });
    const seen: string[] = [];
    agent.bus.on("context.injected", ({ injection }) => seen.push(`injected:${injection.source}`));
    agent.bus.on("turn.started", () => seen.push("turn.started"));

    await agent.send("first");
    await agent.send("second");

    expect(seen).toEqual([
      "injected:project-instructions",
      "injected:memory-bootstrap",
      "turn.started",
      "turn.started",
    ]);
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

  it("queues a send while a turn is in flight and runs it once the turn settles", async () => {
    let calls = 0;
    const provider: Provider = {
      name: "two-phase",
      stream: (request) =>
        calls++ === 0 ? hangUntilAborted(request.signal) : streamOf(textTurn("free again")),
    };
    const agent = new Agent({ provider });

    const first = agent.send("one");
    expect(agent.busy()).toBe(true);
    const second = agent.send("two");
    expect(agent.queued().map((prompt) => prompt.text)).toEqual(["two"]);
    expect(agent.history().filter((message) => message.role === "user")).toHaveLength(1);

    agent.interrupt();
    await first;
    expect(agent.busy()).toBe(true);
    expect(messageText(await second)).toBe("free again");
    expect(agent.busy()).toBe(false);
    expect(agent.queued()).toEqual([]);
  });

  it("hands out a history snapshot that later turns do not mutate", async () => {
    const agent = new Agent({ provider: new MockProvider([textTurn("one")]) });
    const before = agent.history();

    await agent.send("go");

    expect(before).toEqual([]);
    expect(agent.history()).toHaveLength(2);
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

  it("keeps the partial assistant message when the stream fails mid-turn", async () => {
    const provider: Provider = {
      name: "flaky",
      async *stream(): AsyncGenerator<TurnDelta> {
        yield { type: "text", text: "half an answer" };
        throw new Error("wire dropped");
      },
    };
    const agent = new Agent({ provider });

    await expect(agent.send("go")).rejects.toThrow("wire dropped");

    expect(agent.history().map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(agent.history().at(-1)).toMatchObject({
      role: "assistant",
      parts: [{ type: "text", text: "half an answer" }],
    });
    expect(agent.busy()).toBe(false);
  });

  it("never leaves two consecutive user messages after a stream failure and a retry", async () => {
    let calls = 0;
    const provider: Provider = {
      name: "flaky-then-fine",
      async *stream(): AsyncGenerator<TurnDelta> {
        if (calls++ === 0) {
          yield { type: "text", text: "half" };
          throw new Error("wire dropped");
        }
        yield* textTurn("whole");
      },
    };
    const agent = new Agent({ provider });

    await expect(agent.send("first")).rejects.toThrow("wire dropped");
    await agent.send("second");

    const roles = agent.history().map((message) => message.role);
    expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
    expect(roles.some((role, index) => role === "user" && roles[index - 1] === "user")).toBe(false);
  });

  it("settles tool calls orphaned by a stream failure the way an interrupt does", async () => {
    const provider: Provider = {
      name: "flaky-tools",
      async *stream(): AsyncGenerator<TurnDelta> {
        yield {
          type: "tool-call",
          call: { type: "tool-call", callId: "call-1", name: "echo", arguments: { text: "x" } },
        };
        throw new Error("wire dropped");
      },
    };
    const agent = new Agent({ provider, tools: [echoTool] });

    await expect(agent.send("go")).rejects.toThrow("wire dropped");

    expect(orphanedCallIds(agent.history())).toEqual([]);
    expect(agent.history().at(-1)?.parts[0]).toMatchObject({
      type: "tool-result",
      callId: "call-1",
      output: "interrupted before execution",
      isError: true,
    });
  });

  it("stays free and resolves when context.injected or turn.started listeners throw", async () => {
    const provider = new MockProvider([textTurn("one"), textTurn("two")]);
    const agent = new Agent({
      provider,
      standingInjections: [{ source: "project-instructions", id: "AGENTS.md" }],
    });
    const failures: string[] = [];
    agent.bus.on("engine.error", ({ error }) => failures.push(error.message));
    agent.bus.on("context.injected", () => {
      throw new Error("bad tap");
    });
    agent.bus.on("turn.started", () => {
      throw new Error("render crashed");
    });

    expect(messageText(await agent.send("first"))).toBe("one");

    expect(agent.busy()).toBe(false);
    expect(failures).toEqual(["bad tap", "render crashed"]);
    expect(messageText(await agent.send("second"))).toBe("two");
    expect(agent.busy()).toBe(false);
  });

  it("never rejects a successful turn because a turn.completed listener threw", async () => {
    const provider = new MockProvider([textTurn("done"), textTurn("again")]);
    const agent = new Agent({ provider });
    const failures: string[] = [];
    agent.bus.on("engine.error", ({ error }) => failures.push(error.message));
    agent.bus.on("turn.completed", () => {
      throw new Error("render crashed");
    });

    const final = await agent.send("go");

    expect(messageText(final)).toBe("done");
    expect(failures).toEqual(["render crashed"]);
    expect(agent.busy()).toBe(false);
    expect(agent.history().map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messageText(await agent.send("more"))).toBe("again");
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

function lastUserText(messages: readonly Message[]): string {
  const last = messages.at(-1);
  return last === undefined ? "" : messageText(last);
}

describe("Agent visible thinking", () => {
  function recordingProvider(requests: Record<string, unknown>[]): Provider {
    return {
      name: "recording",
      stream: (request) => {
        requests.push({ ...request });
        return streamOf([
          { type: "visible-thinking", text: "First, " },
          { type: "visible-thinking", text: "consider." },
          { type: "text", text: "Done." },
          { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
        ]);
      },
    };
  }

  it("carries the thinking flag only once switched on and keeps the streamed reasoning as its own part", async () => {
    const requests: Record<string, unknown>[] = [];
    const agent = new Agent({ provider: recordingProvider(requests) });
    expect(agent.thinking()).toBe(false);
    await agent.send("one");
    expect("thinking" in (requests[0] ?? {})).toBe(false);

    agent.setThinking(true);
    await agent.send("two");
    expect(requests[1]?.thinking).toBe(true);
    expect(agent.history().at(-1)?.parts).toEqual([
      { type: "visible-thinking", text: "First, consider." },
      { type: "text", text: "Done." },
    ]);

    agent.setThinking(false);
    await agent.send("three");
    expect("thinking" in (requests[2] ?? {})).toBe(false);
  });

  it("starts with thinking on when constructed that way", () => {
    expect(new Agent({ provider: new MockProvider([]), thinking: true }).thinking()).toBe(true);
  });
});

describe("Agent turn queue", () => {
  it("delivers three queued prompts after the turn, in order, each as its own turn, staying busy throughout", async () => {
    const prompts: string[] = [];
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const provider: Provider = {
      name: "gated",
      async *stream(request): AsyncGenerator<TurnDelta> {
        prompts.push(lastUserText(request.messages));
        if (prompts.length === 1) await gate;
        yield* textTurn(`re: ${prompts.at(-1)}`);
      },
    };
    const agent = new Agent({ provider });
    const busyAtTurnStart: boolean[] = [];
    agent.bus.on("turn.started", () => busyAtTurnStart.push(agent.busy()));

    const first = agent.send("one");
    const second = agent.send("two", { behavior: "queue" });
    const third = agent.send("three", { behavior: "queue" });
    const fourth = agent.send("four", { behavior: "queue" });
    expect(agent.queued().map((prompt) => prompt.text)).toEqual(["two", "three", "four"]);

    open();
    expect(messageText(await first)).toBe("re: one");
    expect(agent.busy()).toBe(true);
    expect(messageText(await second)).toBe("re: two");
    expect(agent.busy()).toBe(true);
    expect(messageText(await third)).toBe("re: three");
    expect(agent.busy()).toBe(true);
    expect(messageText(await fourth)).toBe("re: four");
    expect(agent.busy()).toBe(false);

    expect(prompts).toEqual(["one", "two", "three", "four"]);
    expect(busyAtTurnStart).toEqual([true, true, true, true]);
    expect(agent.history().map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("steer interrupts a slow tool mid-execution and the model sees the steering message next", async () => {
    let toolAborted = false;
    const slowTool: Tool = {
      ...echoTool,
      name: "slow",
      execute: (_args, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              toolAborted = true;
              reject(new Error("tool aborted"));
            },
            { once: true },
          );
        }),
    };
    const requests: string[][] = [];
    const provider: Provider = {
      name: "steerable",
      stream: (request) => {
        requests.push(request.messages.map((message) => `${message.role}:${messageText(message)}`));
        return requests.length === 1
          ? streamOf(
              toolCallTurn({ type: "tool-call", callId: "call-1", name: "slow", arguments: {} }),
            )
          : streamOf(textTurn("steered"));
      },
    };
    const agent = new Agent({ provider, tools: [slowTool] });
    const toolStarted = new Promise<void>((resolve) =>
      agent.bus.on("tool.started", () => resolve()),
    );
    const events: string[] = [];
    agent.bus.on("turn.interrupted", () => events.push("interrupted"));
    agent.bus.on("turn.completed", () => events.push("completed"));

    const first = agent.send("go");
    await toolStarted;
    const steered = agent.send("stop, do this instead", { behavior: "steer" });
    expect(agent.queued().map((prompt) => prompt.behavior)).toEqual(["steer"]);

    await first;
    expect(toolAborted).toBe(true);
    expect(messageText(await steered)).toBe("steered");
    expect(events).toEqual(["interrupted", "completed"]);
    expect(requests.at(-1)?.at(-1)).toBe("user:stop, do this instead");
    expect(orphanedCallIds(agent.history())).toEqual([]);
    expect(agent.busy()).toBe(false);
  });

  it("runs steers ahead of queued prompts, in the order they were steered", async () => {
    const prompts: string[] = [];
    const provider: Provider = {
      name: "ordered",
      stream: (request) => {
        prompts.push(lastUserText(request.messages));
        return prompts.length === 1 ? hangUntilAborted(request.signal) : streamOf(textTurn("ok"));
      },
    };
    const agent = new Agent({ provider });

    const first = agent.send("first");
    const queued = agent.send("queued", { behavior: "queue" });
    const steerOne = agent.send("steer one", { behavior: "steer" });
    const steerTwo = agent.send("steer two", { behavior: "steer" });
    expect(agent.queued().map((prompt) => prompt.text)).toEqual([
      "steer one",
      "steer two",
      "queued",
    ]);

    await Promise.all([first, queued, steerOne, steerTwo]);

    expect(prompts).toEqual(["first", "steer one", "steer two", "queued"]);
  });

  it("steers an idle agent like a plain send", async () => {
    const agent = new Agent({ provider: new MockProvider([textTurn("hi")]) });
    let interrupted = false;
    agent.bus.on("turn.interrupted", () => {
      interrupted = true;
    });

    expect(messageText(await agent.send("now", { behavior: "steer" }))).toBe("hi");

    expect(interrupted).toBe(false);
  });

  it("cancels a queued prompt by id, rejects its send, and announces queue changes", async () => {
    let calls = 0;
    const provider: Provider = {
      name: "two-phase",
      stream: (request) =>
        calls++ === 0 ? hangUntilAborted(request.signal) : streamOf(textTurn("ok")),
    };
    const agent = new Agent({ provider });
    const queueSizes: number[] = [];
    agent.bus.on("queue.changed", ({ queued }) => queueSizes.push(queued.length));

    const first = agent.send("one");
    const doomed = agent.send("two");
    const kept = agent.send("three");
    const doomedId = agent.queued()[0]?.id ?? "";
    expect(doomedId).not.toBe("");

    expect(agent.cancelQueued(doomedId)).toBe(true);
    expect(agent.cancelQueued(doomedId)).toBe(false);
    await expect(doomed).rejects.toBeInstanceOf(QueuedPromptCancelledError);
    expect(agent.queued().map((prompt) => prompt.text)).toEqual(["three"]);
    expect(agent.busy()).toBe(true);

    agent.interrupt();
    await first;
    expect(messageText(await kept)).toBe("ok");
    expect(queueSizes).toEqual([1, 2, 1, 0]);
    expect(agent.history().map((message) => message.role)).toEqual(["user", "user", "assistant"]);
  });
});

describe("Agent settlement seam", () => {
  function gate(): { open: () => void; opened: Promise<void> } {
    let open: () => void = () => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { open, opened };
  }

  function replyingProvider(prompts: string[]): Provider {
    return {
      name: "replying",
      stream: (request) => {
        prompts.push(lastUserText(request.messages));
        return streamOf(textTurn(`re: ${prompts.at(-1)}`));
      },
    };
  }

  it("settles after every turn, before the next queued prompt starts, in order", async () => {
    const trace: string[] = [];
    const prompts: string[] = [];
    const agent = new Agent({ provider: replyingProvider(prompts) });
    agent.bus.on("turn.started", ({ userText }) => trace.push(`start ${userText}`));
    agent.settleTurnsWith(async () => {
      trace.push(`settle after ${agent.history().length}`);
      await Promise.resolve();
      trace.push("settled");
    });

    const first = agent.send("one");
    const second = agent.send("two", { behavior: "queue" });
    await Promise.all([first, second]);

    expect(trace).toEqual([
      "start one",
      "settle after 2",
      "settled",
      "start two",
      "settle after 4",
      "settled",
    ]);
    expect(agent.busy()).toBe(false);
  });

  it("stays busy while settling so a prompt sent then queues instead of racing", async () => {
    const settling = gate();
    const release = gate();
    const prompts: string[] = [];
    const agent = new Agent({ provider: replyingProvider(prompts) });
    agent.settleTurnsWith(() => {
      settling.open();
      return release.opened;
    });

    const first = agent.send("one");
    await settling.opened;
    expect(agent.busy()).toBe(true);
    const late = agent.send("late");
    expect(agent.queued().map((prompt) => prompt.text)).toEqual(["late"]);
    expect(prompts).toEqual(["one"]);

    release.open();
    await first;
    expect(messageText(await late)).toBe("re: late");
    expect(prompts).toEqual(["one", "late"]);
  });

  it("loses nothing when the settler throws: the failure is announced and the queue drains", async () => {
    const prompts: string[] = [];
    const agent = new Agent({ provider: replyingProvider(prompts) });
    const errors: string[] = [];
    agent.bus.on("engine.error", ({ error }) => errors.push(error.message));
    let settles = 0;
    agent.settleTurnsWith(async () => {
      settles += 1;
      if (settles === 1) throw new Error("disk full");
    });

    const first = agent.send("one");
    const second = agent.send("two");
    expect(messageText(await first)).toBe("re: one");
    expect(messageText(await second)).toBe("re: two");

    expect(errors).toEqual(["disk full"]);
    expect(prompts).toEqual(["one", "two"]);
    expect(settles).toBe(2);
  });

  it("keeps queued prompts across an interrupted turn and its settlement", async () => {
    let calls = 0;
    const prompts: string[] = [];
    const provider: Provider = {
      name: "interruptible",
      stream: (request) => {
        prompts.push(lastUserText(request.messages));
        return calls++ === 0 ? hangUntilAborted(request.signal) : streamOf(textTurn("ok"));
      },
    };
    const agent = new Agent({ provider });
    const settledAfter: number[] = [];
    agent.settleTurnsWith(async () => {
      settledAfter.push(agent.history().length);
    });

    const first = agent.send("hang");
    const kept = agent.send("kept");
    agent.interrupt();
    await first;
    expect(messageText(await kept)).toBe("ok");

    expect(prompts).toEqual(["hang", "kept"]);
    expect(settledAfter).toEqual([1, 3]);
  });

  it("a turn started while settling is interruptible", async () => {
    let calls = 0;
    const provider: Provider = {
      name: "two-phase",
      stream: (request) =>
        calls++ === 0 ? streamOf(textTurn("first")) : hangUntilAborted(request.signal),
    };
    const agent = new Agent({ provider });
    let queued: Promise<unknown> | undefined;
    agent.settleTurnsWith(async () => {
      queued ??= agent.send("queued");
    });
    const events: string[] = [];
    agent.bus.on("turn.interrupted", () => events.push("interrupted"));

    await agent.send("go");
    expect(agent.busy()).toBe(true);
    agent.interrupt();
    await queued;

    expect(events).toEqual(["interrupted"]);
    expect(agent.busy()).toBe(false);
  });

  it("hold occupies an idle agent, queues prompts behind the work, and refuses while busy", async () => {
    const prompts: string[] = [];
    const agent = new Agent({ provider: replyingProvider(prompts) });
    const work = gate();
    const held = agent.hold(() => work.opened);
    expect(agent.busy()).toBe(true);
    await expect(agent.hold(async () => {})).rejects.toThrow("agent busy");

    const during = agent.send("during");
    expect(agent.queued().map((prompt) => prompt.text)).toEqual(["during"]);
    expect(prompts).toEqual([]);

    work.open();
    await held;
    expect(messageText(await during)).toBe("re: during");
  });

  it("hold surfaces the work's failure to its caller and still drains", async () => {
    const prompts: string[] = [];
    const agent = new Agent({ provider: replyingProvider(prompts) });
    const held = agent.hold(async () => {
      throw new Error("compaction failed");
    });
    const after = agent.send("after");

    await expect(held).rejects.toThrow("compaction failed");
    expect(messageText(await after)).toBe("re: after");
  });

  it("adoptQueue moves waiting prompts onto another agent with their promises and order intact", async () => {
    const stale: string[] = [];
    const fresh: string[] = [];
    const settling = gate();
    const release = gate();
    const previous = new Agent({ provider: replyingProvider(stale) });
    previous.settleTurnsWith(() => {
      settling.open();
      return release.opened;
    });
    const next = new Agent({ provider: replyingProvider(fresh) });

    const first = previous.send("one");
    const two = previous.send("two");
    const three = previous.send("three");
    await settling.opened;

    next.adoptQueue(previous);
    expect(previous.queued()).toEqual([]);
    release.open();
    await first;

    expect(messageText(await two)).toBe("re: two");
    expect(messageText(await three)).toBe("re: three");
    expect(stale).toEqual(["one"]);
    expect(fresh).toEqual(["two", "three"]);
    expect(previous.busy()).toBe(false);
    expect(next.busy()).toBe(false);
  });
});
