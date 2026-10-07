import { describe, expect, it } from "vitest";
import { Agent } from "./agent.ts";
import type { Provider, ProviderRequest, TurnDelta } from "./provider.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import { rawSseResponse } from "./providers/stream-fixtures.ts";
import type { FetchLike } from "./providers/transport.ts";
import type { Tool } from "./tools.ts";

class ScriptedProvider implements Provider {
  readonly name = "scripted";
  readonly requests: ProviderRequest[] = [];

  constructor(private readonly turns: TurnDelta[][]) {}

  async *stream(request: ProviderRequest): AsyncIterable<TurnDelta> {
    this.requests.push(request);
    yield* this.turns.shift() ?? [];
  }
}

const done = (extra: Partial<Extract<TurnDelta, { type: "done" }>> = {}): TurnDelta => ({
  type: "done",
  usage: { inputTokens: 1, outputTokens: 1 },
  ...extra,
});

const say = (text: string, extra: Partial<Extract<TurnDelta, { type: "done" }>> = {}) => [
  { type: "text", text } as TurnDelta,
  done(extra),
];

const call = (name: string, callId: string): TurnDelta[] => [
  { type: "tool-call", call: { type: "tool-call", callId, name, arguments: {} } },
  done(),
];

function activatingSurface(): { tools: () => readonly Tool[] } {
  const probe: Tool = {
    name: "alpha__probe",
    description: "Probes alpha.",
    parameters: { type: "object" },
    execute: async () => "probed",
  };
  let active: Tool[] = [];
  const search: Tool = {
    name: "mcp_tool_search",
    description: "Fetches schemas.",
    parameters: { type: "object" },
    execute: async () => {
      active = [probe];
      return "alpha__probe is now callable";
    },
  };
  return { tools: () => [search, ...active] };
}

describe("Agent request shape", () => {
  it("threads the previous response id and keeps the turn's cache miss until the next turn", async () => {
    const provider = new ScriptedProvider([
      say("one", { responseId: "msg_1" }),
      say("two", { responseId: "msg_2", cacheMiss: { cause: "tools changed" } }),
      say("three", { responseId: "msg_3" }),
    ]);
    const agent = new Agent({ provider });

    await agent.send("first");
    await agent.send("second");
    expect(agent.cacheMiss()).toEqual({ cause: "tools changed" });
    await agent.send("third");

    expect(provider.requests.map((request) => request.cacheDiagnostics)).toEqual([
      { previousResponseId: null },
      { previousResponseId: "msg_1" },
      { previousResponseId: "msg_2" },
    ]);
    expect(agent.cacheMiss()).toBeUndefined();
  });

  it("marks tools activated mid-loop as an addition after the results that activated them", async () => {
    const provider = new ScriptedProvider([
      call("mcp_tool_search", "s1"),
      call("alpha__probe", "p1"),
      say("done"),
    ]);
    const surface = activatingSurface();
    const agent = new Agent({ provider, tools: surface.tools });

    await agent.send("probe alpha");

    const [first, second, third] = provider.requests;
    expect(first?.toolAdditions).toBeUndefined();
    expect(second?.toolAdditions).toEqual([
      {
        before: 3,
        tools: [
          { name: "alpha__probe", description: "Probes alpha.", parameters: { type: "object" } },
        ],
      },
    ]);
    expect(third?.toolAdditions).toEqual(second?.toolAdditions);
    expect(second?.tools.map((tool) => tool.name)).toEqual(["mcp_tool_search", "alpha__probe"]);
  });

  it("keeps the opening effort at the top and records later changes before their prompt", async () => {
    const provider = new ScriptedProvider([say("a"), say("b"), say("c"), say("d")]);
    const agent = new Agent({ provider, effort: "high" });

    await agent.send("one");
    agent.setEffort("low");
    await agent.send("two");
    agent.setEffort("low");
    await agent.send("three");
    agent.setEffort("max");
    await agent.send("four");

    expect(agent.effort()).toBe("max");
    expect(provider.requests.map((request) => request.effort)).toEqual([
      "high",
      "high",
      "high",
      "high",
    ]);
    expect(provider.requests.at(-1)?.effortChanges).toEqual([
      { before: 2, level: "low" },
      { before: 6, level: "max" },
    ]);
    expect(provider.requests[0]?.effortChanges).toBeUndefined();
  });

  it("sends no effort fields when none was ever chosen", async () => {
    const provider = new ScriptedProvider([say("a")]);
    await new Agent({ provider }).send("one");
    const [request] = provider.requests;
    expect(request !== undefined && "effort" in request).toBe(false);
    expect(request !== undefined && "effortChanges" in request).toBe(false);
  });

  it("shows progress notes live but never keeps them in the assistant message", async () => {
    const provider = new ScriptedProvider([
      [{ type: "progress", text: "Found it. Editing next." }, ...say("Fixed.")],
    ]);
    const agent = new Agent({ provider });
    const seen: string[] = [];
    agent.bus.on("turn.delta", ({ delta }) => {
      if (delta.type === "progress") seen.push(delta.text);
    });

    await agent.send("fix it");

    expect(seen).toEqual(["Found it. Editing next."]);
    expect(agent.history().at(-1)?.parts).toEqual([{ type: "text", text: "Fixed." }]);
  });
});

describe("Agent on Opus 5.5 through the Anthropic wire", () => {
  it("keeps tools and the earlier prefix byte-stable when tool search activates a tool", async () => {
    const bodies: { tools: unknown[]; messages: unknown[] }[] = [];
    const replies = [
      toolUse("toolu_s", "mcp_tool_search"),
      toolUse("toolu_p", "alpha__probe"),
      finalText("probed fine"),
    ];
    const fetchFn: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(init?.body as string));
      return rawSseResponse(replies.shift() ?? "");
    };
    const provider = new AnthropicProvider({
      name: "anthropic",
      baseUrl: "https://api.example.test/v1",
      model: "claude-opus-5-5",
      apiKey: "sk-ant-test",
      fetchFn,
    });
    const agent = new Agent({ provider, tools: activatingSurface().tools });

    await agent.send("probe alpha");

    const [first, second, third] = bodies;
    expect(second?.tools).toEqual(first?.tools);
    expect(third?.tools).toEqual(first?.tools);
    expect(second?.messages.slice(0, first?.messages.length)).toEqual(first?.messages);
    expect(third?.messages.slice(0, second?.messages.length)).toEqual(second?.messages);
    expect(second?.messages.at(-1)).toMatchObject({
      role: "system",
      content: [{ type: "tool_addition", tool: { definition: { name: "alpha__probe" } } }],
    });
  });
});

function sse(...frames: object[]): string {
  return frames
    .map((data) => `event: ${(data as { type: string }).type}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
}

function toolUse(id: string, name: string): string {
  return sse(
    { type: "message_start", message: { id: `msg_${id}`, usage: { input_tokens: 5 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{}" },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  );
}

function finalText(text: string): string {
  return sse(
    { type: "message_start", message: { id: "msg_final", usage: { input_tokens: 5 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  );
}
