import {
  type ImagePart,
  type Message,
  messageText,
  ownedBy,
  type Part,
  type ProviderStateOwner,
  type ToolCallPart,
} from "../messages.ts";
import type { ProviderRequest } from "../provider.ts";

// The Responses surface rejects an empty instructions field, so a neutral
// fallback stands in when no system prompt was assembled.
const defaultInstructions = "You are a helpful assistant.";

export function toResponsesRequest(
  request: ProviderRequest,
  model: string,
  owner?: ProviderStateOwner,
): object {
  return {
    model,
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    instructions: request.systemPrompt === "" ? defaultInstructions : request.systemPrompt,
    input: request.messages.flatMap((message) => toInputItems(message, owner)),
    ...(request.tools.length > 0 && { tools: request.tools.map(toWireTool) }),
  };
}

function toInputItems(message: Message, owner: ProviderStateOwner | undefined): object[] {
  switch (message.role) {
    case "system":
      return [roleItem("system", [{ type: "input_text", text: messageText(message) }])];
    case "user":
      return [roleItem("user", message.parts.flatMap(userContentPart))];
    case "assistant":
      return message.parts.flatMap((part) => assistantItem(part, owner));
    case "tool":
      return message.parts.flatMap((part) =>
        part.type === "tool-result"
          ? [{ type: "function_call_output", call_id: part.callId, output: part.output }]
          : [],
      );
  }
}

function roleItem(role: string, content: object[]): object {
  return { role, content };
}

function userContentPart(part: Part): object[] {
  switch (part.type) {
    case "text":
      return [{ type: "input_text", text: part.text }];
    case "image":
      return [{ type: "input_image", image_url: imageDataUrl(part) }];
    default:
      return [];
  }
}

function imageDataUrl(part: ImagePart): string {
  return `data:${part.mediaType};base64,${part.data}`;
}

function assistantItem(part: Part, owner: ProviderStateOwner | undefined): object[] {
  switch (part.type) {
    case "text":
      return part.text === ""
        ? []
        : [roleItem("assistant", [{ type: "output_text", text: part.text }])];
    case "tool-call":
      return [functionCallItem(part)];
    case "redacted-thinking":
      return ownedBy(part, owner) ? reasoningItem(part.data) : [];
    default:
      return [];
  }
}

function functionCallItem(call: ToolCallPart): object {
  return {
    type: "function_call",
    call_id: call.callId,
    name: call.name,
    arguments: JSON.stringify(call.arguments),
  };
}

function reasoningItem(data: string): object[] {
  try {
    const item: unknown = JSON.parse(data);
    return typeof item === "object" && item !== null ? [item] : [];
  } catch {
    return [];
  }
}

function toWireTool(tool: { name: string; description: string; parameters: unknown }): object {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}
