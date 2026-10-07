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
import {
  type EffortLevel,
  effortInForce,
  type ProviderRequest,
  type ToolDefinition,
} from "../provider.ts";
import { claudeSupports } from "./claude-models.ts";

export interface MessagesRequestShape {
  maxTokens: number;
}

export const thinkingBudgetTokens = 16_000;

export type ThinkingReplay = "every-turn" | "current-turn";

export function toMessagesRequest(
  request: ProviderRequest,
  model: string,
  owner: ProviderStateOwner,
  shape: MessagesRequestShape,
): object {
  const inPlace = claudeSupports(model, "mid-conversation-tools");
  const thinking = thinkingConfig(model, shape.maxTokens, request.thinking === true);
  const replay = thinkingReplayFor(model, thinking !== undefined);
  const effort = topLevelEffort(request, model);
  const system = systemText(request, inPlace);
  const tools = offeredTools(request, inPlace);
  return {
    model,
    max_tokens: shape.maxTokens,
    stream: true,
    cache_control: automaticPromptCache,
    ...(thinking !== undefined && { thinking }),
    ...(effort !== undefined && { output_config: { effort } }),
    ...(system !== "" && { system }),
    messages: toWireMessages(request, model, owner, inPlace, replay),
    ...(tools.length > 0 && { tools: tools.map(toWireTool) }),
    ...(request.cacheDiagnostics !== undefined && {
      diagnostics: { previous_message_id: request.cacheDiagnostics.previousResponseId },
    }),
  };
}

export function thinkingConfig(
  model: string,
  maxTokens: number,
  thinkingShown = true,
): object | undefined {
  if (!thinkingShown) {
    return claudeSupports(model, "progress-updates")
      ? { type: "adaptive", display: "updates" }
      : undefined;
  }
  return claudeSupports(model, "adaptive-thinking")
    ? { type: "adaptive", display: "summarized" }
    : { type: "enabled", budget_tokens: Math.min(thinkingBudgetTokens, maxTokens - 1) };
}

export function showsProgressUpdates(model: string, thinkingShown: boolean): boolean {
  return !thinkingShown && claudeSupports(model, "progress-updates");
}

export function thinkingReplayFor(model: string, thinkingConfigured: boolean): ThinkingReplay {
  return thinkingConfigured && claudeSupports(model, "preserved-thinking")
    ? "every-turn"
    : "current-turn";
}

const automaticPromptCache = { type: "ephemeral" } as const;

type WireRole = "user" | "assistant";

interface WireMessage {
  role: WireRole | "system";
  content: object[];
  output_config?: { effort: EffortLevel };
}

interface Turn {
  role: WireRole;
  content: object[];
  firstIndex: number;
  lastIndex: number;
}

interface PositionedBlocks {
  at: number;
  blocks: object[];
}

function topLevelEffort(request: ProviderRequest, model: string): EffortLevel | undefined {
  if (!claudeSupports(model, "effort")) return undefined;
  return claudeSupports(model, "per-message-effort") ? request.effort : effortInForce(request);
}

function systemText(request: ProviderRequest, inPlace: boolean): string {
  const folded = inPlace ? [] : request.messages.filter((message) => message.role === "system");
  return [request.systemPrompt, ...folded.map(messageText)]
    .filter((text) => text !== "")
    .join("\n\n");
}

function offeredTools(request: ProviderRequest, inPlace: boolean): readonly ToolDefinition[] {
  if (!inPlace) return request.tools;
  const added = new Set(
    (request.toolAdditions ?? []).flatMap((addition) => addition.tools.map((tool) => tool.name)),
  );
  return request.tools.filter((tool) => !added.has(tool.name));
}

function toWireMessages(
  request: ProviderRequest,
  model: string,
  owner: ProviderStateOwner,
  inPlace: boolean,
  replay: ThinkingReplay,
): WireMessage[] {
  const turns = conversationTurns(request.messages, owner, replay);
  const efforts = claudeSupports(model, "per-message-effort") ? (request.effortChanges ?? []) : [];
  const systemBlocks = inPlace ? positionedSystemBlocks(request) : [];
  const leading = efforts.map((change) => ({
    slot: turnAtOrAfter(turns, change.before),
    message: effortMessage(change.level),
  }));
  const trailing = systemBlocks.flatMap(({ at, blocks }) => {
    const slot = userTurnHosting(turns, at);
    return slot === undefined ? [] : [{ slot, blocks }];
  });
  return turns
    .flatMap((turn, slot): WireMessage[] => {
      const leadingHere = leading.filter((item) => item.slot === slot).map((item) => item.message);
      const trailingHere = trailing
        .filter((item) => item.slot === slot)
        .flatMap((item) => item.blocks);
      return [
        ...leadingHere,
        { role: turn.role, content: turn.content },
        ...(trailingHere.length > 0 ? [systemMessage(trailingHere)] : []),
      ];
    })
    .concat(leading.filter((item) => item.slot === turns.length).map((item) => item.message));
}

function conversationTurns(
  messages: readonly Message[],
  owner: ProviderStateOwner,
  replay: ThinkingReplay,
): Turn[] {
  const thinkingReplayedFrom = replay === "every-turn" ? 0 : currentTurnStart(messages);
  const turns: Turn[] = [];
  messages.forEach((message, index) => {
    const role = wireRoleOf(message);
    if (role === undefined) return;
    const content = contentOf(message, owner, index >= thinkingReplayedFrom);
    if (content.length === 0) return;
    const previous = turns.at(-1);
    if (previous?.role === role) {
      previous.content.push(...content);
      previous.lastIndex = index;
    } else {
      turns.push({ role, content: [...content], firstIndex: index, lastIndex: index });
    }
  });
  return turns;
}

function currentTurnStart(messages: readonly Message[]): number {
  return messages.findLastIndex((message) => message.role === "user") + 1;
}

function wireRoleOf(message: Message): WireRole | undefined {
  switch (message.role) {
    case "system":
      return undefined;
    case "assistant":
      return "assistant";
    case "user":
    case "tool":
      return "user";
  }
}

function contentOf(
  message: Message,
  owner: ProviderStateOwner,
  thinkingReplayed: boolean,
): object[] {
  switch (message.role) {
    case "system":
      return [];
    case "user":
      return message.parts.flatMap(userBlock);
    case "assistant":
      return message.parts.flatMap((part) => assistantBlock(part, owner, thinkingReplayed));
    case "tool":
      return message.parts.flatMap((part) =>
        part.type === "tool-result" ? [toolResultBlock(part)] : [],
      );
  }
}

function positionedSystemBlocks(request: ProviderRequest): PositionedBlocks[] {
  const additions = (request.toolAdditions ?? []).map((addition) => ({
    at: addition.before,
    blocks: addition.tools.map(toolAdditionBlock),
  }));
  const instructions = request.messages.flatMap((message, index) => {
    const text = message.role === "system" ? messageText(message) : "";
    return text === "" ? [] : [{ at: index, blocks: [{ type: "text", text }] }];
  });
  return [...instructions, ...additions].sort((left, right) => left.at - right.at);
}

function turnAtOrAfter(turns: readonly Turn[], index: number): number {
  const slot = turns.findIndex((turn) => turn.lastIndex >= index);
  return slot === -1 ? turns.length : slot;
}

function userTurnHosting(turns: readonly Turn[], index: number): number | undefined {
  const anchor = turns.findLastIndex((turn) => turn.firstIndex < index);
  const slot = turns.findIndex((turn, at) => at >= anchor && turn.role === "user");
  return slot === -1 ? undefined : slot;
}

function effortMessage(level: EffortLevel): WireMessage {
  return { role: "system", content: [], output_config: { effort: level } };
}

function systemMessage(blocks: object[]): WireMessage {
  return { role: "system", content: blocks };
}

function toolAdditionBlock(tool: ToolDefinition): object {
  return { type: "tool_addition", tool: { type: "tool_definition", definition: toWireTool(tool) } };
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

function assistantBlock(
  part: Part,
  owner: ProviderStateOwner,
  thinkingReplayed: boolean,
): object[] {
  switch (part.type) {
    case "text":
      return part.text === "" ? [] : [{ type: "text", text: part.text }];
    case "tool-call":
      return [toolUseBlock(part)];
    case "redacted-thinking":
      return thinkingReplayed && ownedBy(part, owner) ? replayedThinking(part) : [];
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
