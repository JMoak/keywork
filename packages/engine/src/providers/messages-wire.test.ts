import { describe, expect, it } from "vitest";
import { type Message, textMessage } from "../messages.ts";
import type { ProviderRequest } from "../provider.ts";
import { toChatRequest } from "./chat-wire.ts";
import { thinkingBudgetTokens, thinkingConfig, toMessagesRequest } from "./messages-wire.ts";
import { toResponsesRequest } from "./responses-wire.ts";

const owner = { provider: "anthropic", model: "claude-test" };
const shape = { maxTokens: 1000 };

function request(messages: Message[], overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return { systemPrompt: "", messages, tools: [], ...overrides };
}

function wire(messages: Message[], overrides: Partial<ProviderRequest> = {}) {
  return toMessagesRequest(request(messages, overrides), "claude-test", owner, shape) as {
    system?: string;
    messages: { role: string; content: object[] }[];
    tools?: object[];
    max_tokens: number;
  };
}

describe("toMessagesRequest", () => {
  it("folds the system prompt and system-role messages into one system field", () => {
    const body = wire([textMessage("system", "house rules"), textMessage("user", "hi")], {
      systemPrompt: "You are keywork.",
    });
    expect(body.system).toBe("You are keywork.\n\nhouse rules");
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });

  it("omits the system field entirely when nothing was assembled", () => {
    expect("system" in wire([textMessage("user", "hi")])).toBe(false);
  });

  it("carries images as base64 source blocks", () => {
    const body = wire([
      {
        role: "user",
        parts: [
          { type: "text", text: "what is this" },
          { type: "image", mediaType: "image/png", data: "aGVsbG8=" },
        ],
      },
    ]);
    expect(body.messages[0]?.content).toEqual([
      { type: "text", text: "what is this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
    ]);
  });

  it("puts tool results in a user turn and merges adjacent same-role turns", () => {
    const body = wire([
      textMessage("user", "run it"),
      {
        role: "assistant",
        parts: [
          { type: "tool-call", callId: "a", name: "bash", arguments: { command: "ls" } },
          { type: "tool-call", callId: "b", name: "read", arguments: { path: "x" } },
        ],
      },
      { role: "tool", parts: [{ type: "tool-result", callId: "a", output: "ok", isError: false }] },
      {
        role: "tool",
        parts: [{ type: "tool-result", callId: "b", output: "boom", isError: true }],
      },
    ]);
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "run it" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "a", name: "bash", input: { command: "ls" } },
          { type: "tool_use", id: "b", name: "read", input: { path: "x" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "ok" },
          { type: "tool_result", tool_use_id: "b", content: "boom", is_error: true },
        ],
      },
    ]);
  });

  it("guards tool input to an object when another provider left malformed arguments behind", () => {
    const body = wire([
      textMessage("user", "go"),
      {
        role: "assistant",
        parts: [{ type: "tool-call", callId: "c", name: "bash", arguments: "{oops" }],
      },
      { role: "tool", parts: [{ type: "tool-result", callId: "c", output: "", isError: false }] },
    ]);
    expect(body.messages[1]?.content).toEqual([
      { type: "tool_use", id: "c", name: "bash", input: {} },
    ]);
  });

  it("drops empty text parts and messages that end up with no content", () => {
    const body = wire([
      textMessage("user", "hi"),
      { role: "assistant", parts: [{ type: "text", text: "" }] },
      textMessage("user", "still there?"),
    ]);
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "text", text: "still there?" },
        ],
      },
    ]);
  });

  it("maps tools onto name, description, and input_schema", () => {
    const body = wire([textMessage("user", "hi")], {
      tools: [{ name: "bash", description: "run", parameters: { type: "object" } }],
    });
    expect(body.tools).toEqual([
      { name: "bash", description: "run", input_schema: { type: "object" } },
    ]);
    expect(body.max_tokens).toBe(1000);
  });

  it("requests thinking only when asked, in the shape each Claude generation accepts", () => {
    const messages = [textMessage("user", "hi")];
    expect("thinking" in wire(messages)).toBe(false);
    const thinkingFor = (model: string) =>
      (
        toMessagesRequest(request(messages, { thinking: true }), model, owner, shape) as {
          thinking: object;
        }
      ).thinking;
    const budgeted = { type: "enabled", budget_tokens: 999 };
    const adaptive = { type: "adaptive", display: "summarized" };
    expect(thinkingFor("claude-haiku-4-5")).toEqual(budgeted);
    expect(thinkingFor("anthropic/claude-sonnet-4-5-20250929")).toEqual(budgeted);
    expect(thinkingFor("claude-3-5-sonnet-20241022")).toEqual(budgeted);
    expect(thinkingFor("claude-sonnet-4-6")).toEqual(adaptive);
    expect(thinkingFor("claude-opus-5")).toEqual(adaptive);
    expect(thinkingFor("claude-fable-5-1")).toEqual(adaptive);
    expect(thinkingFor("claude-test")).toEqual(adaptive);
  });

  it("caps the thinking budget under a generous output ceiling", () => {
    expect(thinkingConfig("claude-haiku-4-5", 32_000)).toEqual({
      type: "enabled",
      budget_tokens: thinkingBudgetTokens,
    });
  });

  it("never sends visible thinking, even to the model that produced it", () => {
    const body = wire([
      textMessage("user", "hi"),
      {
        role: "assistant",
        parts: [
          { type: "visible-thinking", text: "shown reasoning" },
          { type: "text", text: "answer" },
        ],
      },
      textMessage("user", "more"),
    ]);
    expect(JSON.stringify(body)).not.toContain("shown reasoning");
    expect(body.messages[1]?.content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("drops unparsable owned thinking rather than sending garbage", () => {
    const body = wire([
      textMessage("user", "hi"),
      {
        role: "assistant",
        parts: [
          { type: "redacted-thinking", data: "not json", owner },
          { type: "text", text: "a" },
        ],
      },
    ]);
    expect(body.messages[1]?.content).toEqual([{ type: "text", text: "a" }]);
  });
});

describe("switching models mid-session through the neutral format", () => {
  const history: Message[] = [
    textMessage("user", "list files"),
    {
      role: "assistant",
      parts: [
        {
          type: "redacted-thinking",
          data: JSON.stringify({ type: "thinking", thinking: "", signature: "sig" }),
          owner,
        },
        { type: "visible-thinking", text: "shown reasoning" },
        { type: "tool-call", callId: "toolu_1", name: "bash", arguments: { command: "ls" } },
      ],
    },
    {
      role: "tool",
      parts: [{ type: "tool-result", callId: "toolu_1", output: "a.ts", isError: false }],
    },
    { role: "assistant", parts: [{ type: "text", text: "One file: a.ts" }] },
    textMessage("user", "thanks"),
  ];

  it("keeps the anthropic transcript intact for a chat-completions provider, minus the private thinking", () => {
    const body = toChatRequest(request(history), "gpt-x") as { messages: object[] };
    expect(body.messages).toEqual([
      { role: "user", content: "list files" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "toolu_1",
            type: "function",
            function: { name: "bash", arguments: '{"command":"ls"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "toolu_1", content: "a.ts" },
      { role: "assistant", content: "One file: a.ts" },
      { role: "user", content: "thanks" },
    ]);
  });

  it("hands the same transcript to a responses provider without leaking anthropic-owned state", () => {
    const body = toResponsesRequest(request(history), "gpt-x", {
      provider: "codex",
      model: "gpt-x",
    }) as {
      input: object[];
    };
    expect(body.input).not.toContainEqual(expect.objectContaining({ type: "thinking" }));
    expect(JSON.stringify(body)).not.toContain("shown reasoning");
    expect(body.input).toContainEqual(
      expect.objectContaining({ type: "function_call", call_id: "toolu_1" }),
    );
  });

  it("drops thinking produced by a different anthropic model when the session switches", () => {
    const switched = toMessagesRequest(
      request(history),
      "claude-other",
      { provider: "anthropic", model: "claude-other" },
      shape,
    ) as { messages: { content: object[] }[] };
    const blocks = switched.messages.flatMap((message) => message.content);
    expect(blocks).not.toContainEqual(expect.objectContaining({ type: "thinking" }));
    expect(JSON.stringify(blocks)).not.toContain("shown reasoning");
    expect(blocks).toContainEqual(expect.objectContaining({ type: "tool_use", id: "toolu_1" }));
  });
});

const opus55 = "claude-opus-5-5";

interface WireBody {
  system?: string;
  messages: { role: string; content: object[]; output_config?: object }[];
  tools?: { name: string }[];
  thinking?: object;
  output_config?: object;
  diagnostics?: object;
  tool_choice?: unknown;
}

function wireFor(model: string, messages: Message[], overrides: Partial<ProviderRequest> = {}) {
  const modelOwner = { provider: "anthropic", model };
  return toMessagesRequest(request(messages, overrides), model, modelOwner, shape) as WireBody;
}

const baseTool = { name: "read", description: "Reads a file.", parameters: { type: "object" } };
const searchTool = {
  name: "mcp_tool_search",
  description: "Fetches schemas.",
  parameters: { type: "object" },
};
const activatedTool = {
  name: "alpha__probe",
  description: "Probes alpha.",
  parameters: { type: "object", properties: { id: { type: "string" } } },
};

const searchLoop: Message[] = [
  textMessage("user", "probe alpha"),
  {
    role: "assistant",
    parts: [
      { type: "tool-call", callId: "s1", name: "mcp_tool_search", arguments: { tools: ["x"] } },
    ],
  },
  { role: "tool", parts: [{ type: "tool-result", callId: "s1", output: "ok", isError: false }] },
];

describe("5.5-generation request shape", () => {
  it("never sends a forced tool_choice or a thinking budget to a 5.5-generation id", () => {
    for (const model of [opus55, "claude-sonnet-5-5", "claude-fable-5-1", "claude-mythos-5-1"]) {
      for (const thinking of [true, false]) {
        const body = wireFor(model, searchLoop, {
          thinking,
          effort: "high",
          tools: [baseTool],
          effortChanges: [{ before: 2, level: "low" }],
        });
        expect(JSON.stringify(body)).not.toContain("budget_tokens");
        expect("tool_choice" in body).toBe(false);
      }
    }
  });

  it("asks a 5.5 model for progress updates while thinking is hidden and summaries when shown", () => {
    const messages = [textMessage("user", "hi")];
    expect(wireFor(opus55, messages).thinking).toEqual({ type: "adaptive", display: "updates" });
    expect(wireFor("claude-sonnet-5-5", messages).thinking).toEqual({
      type: "adaptive",
      display: "updates",
    });
    expect(wireFor(opus55, messages, { thinking: true }).thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    });
    expect("thinking" in wireFor("claude-opus-5", messages)).toBe(false);
    expect("thinking" in wireFor("claude-haiku-4-5", messages)).toBe(false);
  });

  it("keeps the top-level tools fixed and appends activated tools in place on a 5.5 model", () => {
    const before = wireFor(opus55, searchLoop, { tools: [baseTool, searchTool] });
    const after = wireFor(opus55, searchLoop, {
      tools: [baseTool, searchTool, activatedTool],
      toolAdditions: [{ before: 3, tools: [activatedTool] }],
    });

    expect(after.tools).toEqual(before.tools);
    expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
    expect(after.messages.at(-1)).toEqual({
      role: "system",
      content: [
        {
          type: "tool_addition",
          tool: {
            type: "tool_definition",
            definition: {
              name: "alpha__probe",
              description: "Probes alpha.",
              input_schema: activatedTool.parameters,
            },
          },
        },
      ],
    });
  });

  it("holds the addition between the tool results and the next assistant turn as the loop grows", () => {
    const grown: Message[] = [
      ...searchLoop,
      {
        role: "assistant",
        parts: [{ type: "tool-call", callId: "p1", name: "alpha__probe", arguments: {} }],
      },
      {
        role: "tool",
        parts: [{ type: "tool-result", callId: "p1", output: "up", isError: false }],
      },
    ];
    const body = wireFor(opus55, grown, {
      tools: [baseTool, searchTool, activatedTool],
      toolAdditions: [{ before: 3, tools: [activatedTool] }],
    });
    expect(body.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "system",
      "assistant",
      "user",
    ]);
  });

  it("keeps today's full tool list on a model without mid-conversation tool changes", () => {
    for (const model of ["claude-sonnet-5", "claude-haiku-4-5", "claude-test"]) {
      const body = wireFor(model, searchLoop, {
        tools: [baseTool, searchTool, activatedTool],
        toolAdditions: [{ before: 3, tools: [activatedTool] }],
      });
      expect(body.tools?.map((tool) => tool.name)).toEqual([
        "read",
        "mcp_tool_search",
        "alpha__probe",
      ]);
      expect(body.messages.map((message) => message.role)).not.toContain("system");
    }
  });

  it("emits system-role messages in place on a 5.5 model and folds them elsewhere", () => {
    const messages: Message[] = [...searchLoop, textMessage("system", "prefer small diffs")];
    const inPlace = wireFor(opus55, messages, { systemPrompt: "You are keywork." });
    expect(inPlace.system).toBe("You are keywork.");
    expect(inPlace.messages.at(-1)).toEqual({
      role: "system",
      content: [{ type: "text", text: "prefer small diffs" }],
    });
    const folded = wireFor("claude-sonnet-5", messages, { systemPrompt: "You are keywork." });
    expect(folded.system).toBe("You are keywork.\n\nprefer small diffs");
  });

  it("moves a system message that would follow an assistant turn to after the next user turn", () => {
    const messages: Message[] = [
      textMessage("user", "hi"),
      textMessage("assistant", "hello"),
      textMessage("system", "be brief"),
      textMessage("user", "and now?"),
    ];
    expect(wireFor(opus55, messages).messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "system",
    ]);
    expect(wireFor(opus55, messages.slice(0, 3)).messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });
});

describe("effort on the Messages wire", () => {
  const twoTurns: Message[] = [
    textMessage("user", "plan it"),
    textMessage("assistant", "1. 2. 3."),
    textMessage("user", "summarize"),
  ];

  it("sends the opening level at the top and later changes as effort-only system messages", () => {
    const body = wireFor(opus55, twoTurns, {
      effort: "high",
      effortChanges: [{ before: 2, level: "low" }],
    });
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "plan it" }] },
      { role: "assistant", content: [{ type: "text", text: "1. 2. 3." }] },
      { role: "system", content: [], output_config: { effort: "low" } },
      { role: "user", content: [{ type: "text", text: "summarize" }] },
    ]);
  });

  it("keeps the cached prefix when only a per-message change is added", () => {
    const before = wireFor(opus55, twoTurns, { effort: "high" });
    const after = wireFor(opus55, twoTurns, {
      effort: "high",
      effortChanges: [{ before: 2, level: "low" }],
    });
    expect(after.output_config).toEqual(before.output_config);
    expect(after.messages.slice(0, 2)).toEqual(before.messages.slice(0, 2));
  });

  it("hoists a change ahead of the user turn it merges into", () => {
    const interrupted: Message[] = [
      textMessage("user", "go"),
      {
        role: "assistant",
        parts: [{ type: "tool-call", callId: "a", name: "read", arguments: {} }],
      },
      { role: "tool", parts: [{ type: "tool-result", callId: "a", output: "x", isError: true }] },
      textMessage("user", "try again"),
    ];
    const body = wireFor(opus55, interrupted, { effortChanges: [{ before: 3, level: "max" }] });
    expect(body.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "system",
      "user",
    ]);
    expect("output_config" in body).toBe(false);
  });

  it("sends the level in force at the top on a model without per-message effort", () => {
    const body = wireFor("claude-sonnet-4-6", twoTurns, {
      effort: "high",
      effortChanges: [{ before: 2, level: "low" }],
    });
    expect(body.output_config).toEqual({ effort: "low" });
    expect(body.messages.map((message) => message.role)).not.toContain("system");
  });

  it("sends no effort to a model that does not take it", () => {
    const body = wireFor("claude-haiku-4-5", twoTurns, { effort: "low" });
    expect("output_config" in body).toBe(false);
  });
});

describe("cache diagnostics on the Messages wire", () => {
  it("opts in only when the request carries the thread, null on the first turn", () => {
    const messages = [textMessage("user", "hi")];
    expect("diagnostics" in wireFor(opus55, messages)).toBe(false);
    expect(
      wireFor(opus55, messages, { cacheDiagnostics: { previousResponseId: null } }).diagnostics,
    ).toEqual({ previous_message_id: null });
    expect(
      wireFor("claude-haiku-4-5", messages, { cacheDiagnostics: { previousResponseId: "msg_1" } })
        .diagnostics,
    ).toEqual({ previous_message_id: "msg_1" });
  });
});

describe("thinking replay across turns", () => {
  const ownedOn = (model: string) => ({ provider: "anthropic", model });
  const thinkingBlock = (signature: string) =>
    JSON.stringify({ type: "thinking", thinking: "", signature });
  const toolTurn = (model: string): Message[] => [
    textMessage("user", "list the repo"),
    {
      role: "assistant",
      parts: [
        { type: "redacted-thinking", data: thinkingBlock("s-plan"), owner: ownedOn(model) },
        { type: "tool-call", callId: "t1", name: "bash", arguments: { command: "ls" } },
      ],
    },
    { role: "tool", parts: [{ type: "tool-result", callId: "t1", output: "src", isError: false }] },
    {
      role: "assistant",
      parts: [
        { type: "redacted-thinking", data: thinkingBlock("s-answer"), owner: ownedOn(model) },
        { type: "text", text: "one folder: src" },
      ],
    },
  ];
  const signaturesIn = (body: WireBody) =>
    body.messages.flatMap((message) =>
      message.content.flatMap((block) =>
        "signature" in block ? [(block as { signature: string }).signature] : [],
      ),
    );

  it("keeps the prefix byte-stable across turns on a model that preserves thinking", () => {
    const first = wireFor(opus55, toolTurn(opus55));
    const second = wireFor(opus55, [...toolTurn(opus55), textMessage("user", "now test it")]);

    expect(signaturesIn(first)).toEqual(["s-plan", "s-answer"]);
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
  });

  it("drops the earlier turn's thinking on a model that strips it server-side", () => {
    const haiku = "claude-haiku-4-5";
    const second = wireFor(haiku, [...toolTurn(haiku), textMessage("user", "now test it")], {
      thinking: true,
    });
    expect(signaturesIn(second)).toEqual([]);
    const midLoop = wireFor(haiku, toolTurn(haiku).slice(0, 3), { thinking: true });
    expect(signaturesIn(midLoop)).toEqual(["s-plan"]);
  });

  it("falls back to current-turn replay when the request carries no thinking config", () => {
    const opus5 = "claude-opus-5";
    const history = [...toolTurn(opus5), textMessage("user", "again")];
    expect(signaturesIn(wireFor(opus5, history))).toEqual([]);
    expect(signaturesIn(wireFor(opus5, history, { thinking: true }))).toEqual([
      "s-plan",
      "s-answer",
    ]);
  });

  it("never replays another model's blocks even where thinking is preserved", () => {
    const history = toolTurn("claude-sonnet-5-5");
    expect(signaturesIn(wireFor(opus55, history))).toEqual([]);
  });
});
