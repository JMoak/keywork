export { Agent, type AgentOptions } from "./agent.ts";
export { type EngineEvents, EventBus } from "./bus.ts";
export {
  type Message,
  messageText,
  type Part,
  type Role,
  type TextPart,
  type ToolCallPart,
  type ToolResultPart,
  textMessage,
  toolCalls,
  type Usage,
} from "./messages.ts";
export { MockProvider, textTurn, toolCallTurn } from "./mock-provider.ts";
export { buildSystemPrompt, loadProjectInstructions } from "./prompt.ts";
export type {
  Provider,
  ProviderRequest,
  ToolDefinition,
  TurnDelta,
} from "./provider.ts";
export {
  type FetchLike,
  type OpenAiCompatibleOptions,
  OpenAiCompatibleProvider,
  ProviderHttpError,
} from "./providers/openai.ts";
export { RetryingProvider, type RetryOptions } from "./providers/retry.ts";
export {
  type MessageEntry,
  type SessionEntry,
  type SessionHeader,
  SessionStore,
} from "./session/store.ts";
export { kebabTitle, suggestTitle } from "./titles.ts";
export { bashTool, detectShell, type Shell } from "./tools/bash.ts";
export { coreTools } from "./tools/core.ts";
export { defineTool } from "./tools/define.ts";
export { editTool } from "./tools/edit.ts";
export { readTool } from "./tools/read.ts";
export { writeTool } from "./tools/write.ts";
export { findTool, type Tool, ToolNotFoundError } from "./tools.ts";

export const engineVersion = "0.0.1";
