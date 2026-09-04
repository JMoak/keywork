import { describe, expect, it } from "vitest";
import { type Message, textMessage } from "../messages.ts";
import type { ProviderRequest } from "../provider.ts";
import { toChatRequest } from "./chat-wire.ts";
import { toMessagesRequest } from "./messages-wire.ts";
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
    expect(blocks).toContainEqual(expect.objectContaining({ type: "tool_use", id: "toolu_1" }));
  });
});
