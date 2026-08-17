import { describe, expect, it } from "vitest";
import type { Message, Part, Usage } from "../messages.ts";

// Paper fixtures hand-written from public Messages-API documentation (90 §Resequencing);
// no client, endpoint, or auth exists here.

type PaperBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface PaperMessage {
  role: "user" | "assistant";
  content: PaperBlock[];
}

interface PaperUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface PaperRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: PaperMessage[];
}

interface PaperResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: PaperBlock[];
  stop_reason: string;
  stop_sequence: null;
  usage: PaperUsage;
}

const requestFixture: PaperRequest = {
  model: "paper-model",
  max_tokens: 4096,
  system: "You are a careful coding agent.",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "What does this screenshot show?" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "The screenshot is a terminal.", signature: "sig-abc==" },
        { type: "text", text: "Let me read the file it shows." },
        { type: "tool_use", id: "toolu_01", name: "read", input: { path: "src/main.ts" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "export const x = 1;" }],
    },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_02", name: "edit", input: { path: "missing.ts", old: "a" } },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_02",
          content: "file not found",
          is_error: true,
        },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "The edit target does not exist." }] },
  ],
};

const responseFixture: PaperResponse = {
  id: "msg_paper_01",
  type: "message",
  role: "assistant",
  model: "paper-model",
  content: [
    { type: "thinking", thinking: "Cache made this turn cheap.", signature: "sig-def==" },
    { type: "redacted_thinking", data: "b3BhcXVl" },
    { type: "text", text: "Reading the config next." },
    { type: "tool_use", id: "toolu_03", name: "read", input: { path: "keywork.json" } },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: {
    input_tokens: 2048,
    output_tokens: 312,
    cache_creation_input_tokens: 1024,
    cache_read_input_tokens: 512,
  },
};

describe("Anthropic-shaped paper fixtures round-trip the neutral format", () => {
  it("request: fixture -> neutral -> fixture, losslessly", () => {
    const neutral = neutralRequest(requestFixture);
    expect(paperRequest(neutral, requestFixture.model, requestFixture.max_tokens)).toEqual(
      requestFixture,
    );
  });

  it("request: tool_result messages become neutral tool-role messages", () => {
    const { messages } = neutralRequest(requestFixture);
    expect(messages[2]).toEqual({
      role: "tool",
      parts: [
        { type: "tool-result", callId: "toolu_01", output: "export const x = 1;", isError: false },
      ],
    });
  });

  it("response: fixture -> neutral -> fixture, thinking and cache usage intact", () => {
    const { message, usage } = neutralResponse(responseFixture);
    expect(message.parts).toContainEqual({
      type: "thinking",
      thinking: "Cache made this turn cheap.",
      signature: "sig-def==",
    });
    expect(usage).toEqual({
      inputTokens: 2048,
      outputTokens: 312,
      cacheCreationInputTokens: 1024,
      cacheReadInputTokens: 512,
    });
    expect(
      paperResponse(message, usage, {
        id: responseFixture.id,
        model: responseFixture.model,
        stopReason: responseFixture.stop_reason,
      }),
    ).toEqual(responseFixture);
  });

  it("usage without cache fields round-trips without inventing them", () => {
    const bare: PaperUsage = { input_tokens: 7, output_tokens: 3 };
    expect(paperUsage(neutralUsage(bare))).toEqual(bare);
  });
});

function neutralRequest(paper: PaperRequest): { systemPrompt: string; messages: Message[] } {
  return { systemPrompt: paper.system ?? "", messages: paper.messages.map(neutralMessage) };
}

function paperRequest(
  neutral: { systemPrompt: string; messages: Message[] },
  model: string,
  maxTokens: number,
): PaperRequest {
  return {
    model,
    max_tokens: maxTokens,
    ...(neutral.systemPrompt !== "" && { system: neutral.systemPrompt }),
    messages: neutral.messages.map(paperMessage),
  };
}

function neutralResponse(paper: PaperResponse): { message: Message; usage: Usage } {
  return {
    message: { role: "assistant", parts: paper.content.map(neutralPart) },
    usage: neutralUsage(paper.usage),
  };
}

function paperResponse(
  message: Message,
  usage: Usage,
  envelope: { id: string; model: string; stopReason: string },
): PaperResponse {
  return {
    id: envelope.id,
    type: "message",
    role: "assistant",
    model: envelope.model,
    content: message.parts.map(paperBlock),
    stop_reason: envelope.stopReason,
    stop_sequence: null,
    usage: paperUsage(usage),
  };
}

function neutralMessage(paper: PaperMessage): Message {
  const toolOnly = paper.content.every((block) => block.type === "tool_result");
  const role = paper.role === "user" && toolOnly ? "tool" : paper.role;
  return { role, parts: paper.content.map(neutralPart) };
}

function paperMessage(message: Message): PaperMessage {
  return {
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.parts.map(paperBlock),
  };
}

function neutralPart(block: PaperBlock): Part {
  switch (block.type) {
    case "text":
      return block;
    case "image":
      return { type: "image", mediaType: block.source.media_type, data: block.source.data };
    case "thinking":
      return block;
    case "redacted_thinking":
      return { type: "redacted-thinking", data: block.data };
    case "tool_use":
      return { type: "tool-call", callId: block.id, name: block.name, arguments: block.input };
    case "tool_result":
      return {
        type: "tool-result",
        callId: block.tool_use_id,
        output: block.content,
        isError: block.is_error === true,
      };
  }
}

function paperBlock(part: Part): PaperBlock {
  switch (part.type) {
    case "text":
      return part;
    case "image":
      return {
        type: "image",
        source: { type: "base64", media_type: part.mediaType, data: part.data },
      };
    case "thinking":
      return { type: "thinking", thinking: part.thinking, signature: part.signature };
    case "redacted-thinking":
      return { type: "redacted_thinking", data: part.data };
    case "tool-call":
      return { type: "tool_use", id: part.callId, name: part.name, input: part.arguments };
    case "tool-result":
      return {
        type: "tool_result",
        tool_use_id: part.callId,
        content: part.output,
        ...(part.isError && { is_error: true }),
      };
  }
}

function neutralUsage(paper: PaperUsage): Usage {
  return {
    inputTokens: paper.input_tokens,
    outputTokens: paper.output_tokens,
    ...(paper.cache_creation_input_tokens !== undefined && {
      cacheCreationInputTokens: paper.cache_creation_input_tokens,
    }),
    ...(paper.cache_read_input_tokens !== undefined && {
      cacheReadInputTokens: paper.cache_read_input_tokens,
    }),
  };
}

function paperUsage(usage: Usage): PaperUsage {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    ...(usage.cacheCreationInputTokens !== undefined && {
      cache_creation_input_tokens: usage.cacheCreationInputTokens,
    }),
    ...(usage.cacheReadInputTokens !== undefined && {
      cache_read_input_tokens: usage.cacheReadInputTokens,
    }),
  };
}
