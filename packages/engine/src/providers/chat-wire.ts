import {
  type ImagePart,
  type Message,
  messageText,
  type Part,
  type ToolCallPart,
  toolCalls,
} from "../messages.ts";
import type { ProviderRequest } from "../provider.ts";

export function toChatRequest(request: ProviderRequest, model: string): object {
  return {
    model,
    stream: true,
    stream_options: { include_usage: true },
    messages: toWireMessages(request),
    ...(request.tools.length > 0 && { tools: request.tools.map(toWireTool) }),
  };
}

function toWireMessages(request: ProviderRequest): object[] {
  const system =
    request.systemPrompt === "" ? [] : [{ role: "system", content: request.systemPrompt }];
  return [...system, ...request.messages.flatMap(toWire)];
}

function toWire(message: Message): object[] {
  switch (message.role) {
    case "system":
      return [{ role: "system", content: messageText(message) }];
    case "user":
      return [{ role: "user", content: userContent(message) }];
    case "assistant":
      return [assistantWire(message)];
    case "tool":
      return message.parts.flatMap((part) =>
        part.type === "tool-result"
          ? [{ role: "tool", tool_call_id: part.callId, content: part.output }]
          : [],
      );
  }
}

function userContent(message: Message): string | object[] {
  if (!message.parts.some((part) => part.type === "image")) return messageText(message);
  return message.parts.flatMap(userContentPart);
}

function userContentPart(part: Part): object[] {
  switch (part.type) {
    case "text":
      return [{ type: "text", text: part.text }];
    case "image":
      return [{ type: "image_url", image_url: { url: imageDataUrl(part) } }];
    default:
      return [];
  }
}

function imageDataUrl(part: ImagePart): string {
  return `data:${part.mediaType};base64,${part.data}`;
}

function assistantWire(message: Message): object {
  const text = messageText(message);
  const calls = toolCalls(message);
  return {
    role: "assistant",
    ...(text !== "" && { content: text }),
    ...(calls.length > 0 && { tool_calls: calls.map(wireToolCall) }),
  };
}

function wireToolCall(call: ToolCallPart): object {
  return {
    id: call.callId,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  };
}

function toWireTool(tool: { name: string; description: string; parameters: unknown }): object {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}
