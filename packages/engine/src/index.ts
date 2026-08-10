export { Agent, AgentBusyError, type AgentOptions, type ToolGuard } from "./agent.ts";
export { type EngineEvents, EventBus } from "./bus.ts";
export { Checkpoints, type CheckpointsOptions } from "./checkpoints.ts";
export {
  type DiagnosticsLevel,
  type DiagnosticsLine,
  DiagnosticsLog,
  debugEnabled,
  debugLogFile,
  redactSecrets,
} from "./diagnostics.ts";
export {
  type ImagePart,
  type Message,
  messageText,
  type Part,
  type RedactedThinkingPart,
  type Role,
  type TextPart,
  type ThinkingPart,
  type ToolCallPart,
  type ToolResultPart,
  textMessage,
  toolCalls,
  type Usage,
} from "./messages.ts";
export { MockProvider, textTurn, toolCallTurn } from "./mock-provider.ts";
export {
  buildSystemPrompt,
  loadProjectInstructions,
  type SystemPromptOptions,
} from "./prompt.ts";
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
  ProviderStreamError,
} from "./providers/openai.ts";
export { RetryingProvider, type RetryOptions } from "./providers/retry.ts";
export {
  type CompactionOptions,
  type CompactionPlan,
  type CompactionSettings,
  compactSession,
  defaultCompactionSettings,
  estimateContextTokens,
  planCompaction,
  serializeConversation,
  shouldCompact,
} from "./session/compaction.ts";
export {
  type BranchSummaryEntry,
  type CompactionEntry,
  type CustomEntry,
  type CustomMessageEntry,
  type FileEntry,
  type FileTrackingDetails,
  type LabelEntry,
  type MessageEntry,
  type ModelChangeEntry,
  type SessionEntry,
  type SessionHeader,
  type SessionInfoEntry,
  type SessionTreeNode,
  sessionFormatVersion,
  type ThinkingLevelChangeEntry,
} from "./session/entries.ts";
export { replaySession } from "./session/replay.ts";
export {
  type BranchSummaryInput,
  type CompactionInput,
  type SessionStats,
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
