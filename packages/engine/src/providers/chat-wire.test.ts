import { describe, expect, it } from "vitest";
import type { Message } from "../messages.ts";
import { textMessage } from "../messages.ts";
import type { ProviderRequest } from "../provider.ts";
import { toChatRequest } from "./chat-wire.ts";

function request(messages: Message[]): ProviderRequest {
  return { systemPrompt: "", messages, tools: [] };
}

function wireMessages(messages: Message[]): unknown {
  return (toChatRequest(request(messages), "paper-model") as { messages: unknown }).messages;
}

describe("toChatRequest image parts", () => {
  it("keeps text-only user messages as plain string content", () => {
    expect(wireMessages([textMessage("user", "hi")])).toEqual([{ role: "user", content: "hi" }]);
  });

  it("maps image parts to image_url data-URL content parts in order", () => {
    const message: Message = {
      role: "user",
      parts: [
        { type: "text", text: "what is this?" },
        { type: "image", mediaType: "image/png", data: "aGVsbG8=" },
      ],
    };
    expect(wireMessages([message])).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
        ],
      },
    ]);
  });

  it("drops thinking parts the chat wire cannot express", () => {
    const message: Message = {
      role: "assistant",
      parts: [
        { type: "thinking", thinking: "quietly", signature: "sig==" },
        { type: "redacted-thinking", data: "opaque==" },
        { type: "text", text: "answer" },
      ],
    };
    expect(wireMessages([message])).toEqual([{ role: "assistant", content: "answer" }]);
  });
});
