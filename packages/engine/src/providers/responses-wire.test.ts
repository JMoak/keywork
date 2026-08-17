import { describe, expect, it } from "vitest";
import type { Message } from "../messages.ts";
import { textMessage } from "../messages.ts";
import type { ProviderRequest } from "../provider.ts";
import { toResponsesRequest } from "./responses-wire.ts";

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return { systemPrompt: "sys", messages: [], tools: [], ...overrides };
}

type WireRequest = {
  model: string;
  stream: boolean;
  store: boolean;
  include: string[];
  instructions: string;
  input: unknown[];
  tools?: unknown[];
};

function wire(overrides: Partial<ProviderRequest> = {}): WireRequest {
  return toResponsesRequest(request(overrides), "test-model") as WireRequest;
}

describe("toResponsesRequest", () => {
  it("sets the stateless streaming envelope", () => {
    expect(wire()).toMatchObject({
      model: "test-model",
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      instructions: "sys",
    });
  });

  it("falls back to neutral instructions when no system prompt exists", () => {
    expect(wire({ systemPrompt: "" }).instructions).toBe("You are a helpful assistant.");
  });

  it("maps user and assistant text to typed content items", () => {
    const messages = [textMessage("user", "hi"), textMessage("assistant", "hello")];
    expect(wire({ messages }).input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { role: "assistant", content: [{ type: "output_text", text: "hello" }] },
    ]);
  });

  it("maps images to input_image data urls", () => {
    const messages: Message[] = [
      {
        role: "user",
        parts: [
          { type: "text", text: "see" },
          { type: "image", mediaType: "image/png", data: "aGk=" },
        ],
      },
    ];
    expect(wire({ messages }).input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "see" },
          { type: "input_image", image_url: "data:image/png;base64,aGk=" },
        ],
      },
    ]);
  });

  it("emits reasoning before its function call and pairs the tool result", () => {
    const reasoning = JSON.stringify({ type: "reasoning", id: "rs_1", encrypted_content: "blob" });
    const messages: Message[] = [
      {
        role: "assistant",
        parts: [
          { type: "redacted-thinking", data: reasoning },
          { type: "tool-call", callId: "c1", name: "bash", arguments: { command: "ls" } },
        ],
      },
      {
        role: "tool",
        parts: [{ type: "tool-result", callId: "c1", output: "files", isError: false }],
      },
    ];
    expect(wire({ messages }).input).toEqual([
      { type: "reasoning", id: "rs_1", encrypted_content: "blob" },
      { type: "function_call", call_id: "c1", name: "bash", arguments: '{"command":"ls"}' },
      { type: "function_call_output", call_id: "c1", output: "files" },
    ]);
  });

  it("drops unparseable reasoning payloads instead of corrupting the request", () => {
    const messages: Message[] = [
      { role: "assistant", parts: [{ type: "redacted-thinking", data: "not json" }] },
    ];
    expect(wire({ messages }).input).toEqual([]);
  });

  it("declares tools with flat function fields", () => {
    const tools = [{ name: "bash", description: "run", parameters: { type: "object" } }];
    expect(wire({ tools }).tools).toEqual([
      { type: "function", name: "bash", description: "run", parameters: { type: "object" } },
    ]);
    expect(wire().tools).toBeUndefined();
  });
});
