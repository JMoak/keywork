import {
  type ImagePart,
  type Message,
  messageText,
  ownedBy,
  type Part,
  type ProviderStateOwner,
  type RedactedThinkingPart,
  type ToolCallPart,
  type ToolResultPart,
} from "../messages.ts";
import type { ProviderRequest, ToolDefinition } from "../provider.ts";

export interface MessagesRequestShape {
  maxTokens: number;
}

export const thinkingBudgetTokens = 16_000;

export function toMessagesRequest(
  request: ProviderRequest,
  model: string,
  owner: ProviderStateOwner,
  shape: MessagesRequestShape,
): object {
  const system = systemText(request);
  return {
    model,
    max_tokens: shape.maxTokens,
    stream: true,
    cache_control: automaticPromptCache,
    ...(request.thinking === true && { thinking: thinkingConfig(model, shape.maxTokens) }),
    ...(system !== "" && { system }),
    messages: toWireMessages(request.messages, owner),
    ...(request.tools.length > 0 && { tools: request.tools.map(toWireTool) }),
  };
}

export function thinkingConfig(model: string, maxTokens: number): object {
  return takesThinkingBudget(model)
    ? { type: "enabled", budget_tokens: Math.min(thinkingBudgetTokens, maxTokens - 1) }
    : { type: "adaptive", display: "summarized" };
}

const automaticPromptCache = { type: "ephemeral" } as const;

// Claude 4.6 and later reject budget_tokens and default thinking text to
// omitted; every earlier Claude only thinks when given a budget.
const adaptiveThinkingSince = 4.6;

function takesThinkingBudget(model: string): boolean {
  const id = model.slice(model.lastIndexOf("/") + 1).toLowerCase();
  if (/^claude-\d-/.test(id)) return true;
  const generation = /^claude-(?:haiku|sonnet|opus)-(\d+)(?:-(\d+))?/.exec(id);
  if (generation === null) return false;
  return Number(`${generation[1]}.${generation[2] ?? "0"}`) < adaptiveThinkingSince;
}

interface WireMessage {
  role: "user" | "assistant";
  content: object[];
}

function systemText(request: ProviderRequest): string {
  return [
    request.systemPrompt,
    ...request.messages.filter((message) => message.role === "system").map(messageText),
  ]
    .filter((text) => text !== "")
    .join("\n\n");
}

function toWireMessages(messages: readonly Message[], owner: ProviderStateOwner): WireMessage[] {
  const currentTurnBegins = messages.findLastIndex((message) => message.role === "user");
  const wire = messages.flatMap((message, index) =>
    toWireMessage(message, owner, index > currentTurnBegins),
  );
  return mergeAdjacentRoles(wire);
}

function toWireMessage(
  message: Message,
  owner: ProviderStateOwner,
  inCurrentTurn: boolean,
): WireMessage[] {
  switch (message.role) {
    case "system":
      return [];
    case "user":
      return withContent("user", message.parts.flatMap(userBlock));
    case "assistant":
      return withContent(
        "assistant",
        message.parts.flatMap((part) => assistantBlock(part, owner, inCurrentTurn)),
      );
    case "tool":
      return withContent(
        "user",
        message.parts.flatMap((part) =>
          part.type === "tool-result" ? [toolResultBlock(part)] : [],
        ),
      );
  }
}

function withContent(role: WireMessage["role"], content: object[]): WireMessage[] {
  return content.length === 0 ? [] : [{ role, content }];
}

function mergeAdjacentRoles(messages: readonly WireMessage[]): WireMessage[] {
  return messages.reduce<WireMessage[]>((merged, message) => {
    const previous = merged.at(-1);
    if (previous?.role === message.role) {
      previous.content.push(...message.content);
    } else {
      merged.push({ role: message.role, content: [...message.content] });
    }
    return merged;
  }, []);
}

function userBlock(part: Part): object[] {
  switch (part.type) {
    case "text":
      return part.text === "" ? [] : [{ type: "text", text: part.text }];
    case "image":
      return [imageBlock(part)];
    default:
      return [];
  }
}

function assistantBlock(part: Part, owner: ProviderStateOwner, inCurrentTurn: boolean): object[] {
  switch (part.type) {
    case "text":
      return part.text === "" ? [] : [{ type: "text", text: part.text }];
    case "tool-call":
      return [toolUseBlock(part)];
    case "redacted-thinking":
      return inCurrentTurn && ownedBy(part, owner) ? replayedThinking(part) : [];
    default:
      return [];
  }
}

function imageBlock(part: ImagePart): object {
  return {
    type: "image",
    source: { type: "base64", media_type: part.mediaType, data: part.data },
  };
}

function toolUseBlock(call: ToolCallPart): object {
  return { type: "tool_use", id: call.callId, name: call.name, input: toolInput(call.arguments) };
}

function toolInput(value: unknown): object {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function toolResultBlock(result: ToolResultPart): object {
  return {
    type: "tool_result",
    tool_use_id: result.callId,
    content: result.output,
    ...(result.isError && { is_error: true }),
  };
}

function replayedThinking(part: RedactedThinkingPart): object[] {
  try {
    const block: unknown = JSON.parse(part.data);
    return typeof block === "object" && block !== null ? [block] : [];
  } catch {
    return [];
  }
}

function toWireTool(tool: ToolDefinition): object {
  return { name: tool.name, description: tool.description, input_schema: tool.parameters };
}
