export {
  Agent,
  AgentBusyError,
  type AgentOptions,
  type PermissionResolver,
  type ToolGuard,
  type ToolPermission,
} from "./agent.ts";
export { type EngineEvents, EventBus } from "./bus.ts";
export { Checkpoints, type CheckpointsOptions, UnknownCheckpointError } from "./checkpoints.ts";
export {
  type DiagnosticsLevel,
  type DiagnosticsLine,
  DiagnosticsLog,
  debugEnabled,
  debugLogFile,
  redactSecrets,
} from "./diagnostics.ts";
export type {
  ExtensionLoadFailure,
  LayeredDirs,
  LayerSource,
} from "./extensions/layers.ts";
export {
  type AgentDefinition,
  type AgentLoad,
  loadAgents,
  narrowedPermissions,
  restrictTools,
} from "./extensions/markdown-agents.ts";
export {
  type CommandDefinition,
  type CommandLoad,
  type CommandRuntime,
  fileEmbedder,
  loadCommands,
  renderCommand,
  scanTemplate,
  type TemplateSegment,
} from "./extensions/markdown-commands.ts";
export {
  discoverSkills,
  type SkillDefinition,
  type SkillLoad,
  skillConventionDirs,
  skillTool,
} from "./extensions/skills.ts";
export {
  connectStdioServer,
  McpAbortedError,
  type McpConnection,
  McpProtocolError,
  McpRequestTimeoutError,
  McpServerExitedError,
  type McpTool,
  type McpToolResult,
  mcpProtocolVersion,
  type StdioConnectOptions,
  type StdioServerSpec,
} from "./mcp/client.ts";
export {
  defaultRestartDelaysMs,
  isMcpBackedTool,
  type McpBackedTool,
  McpRegistry,
  McpRegistryClosedError,
  type McpRegistryOptions,
  McpServerNotFoundError,
  type McpServerState,
  type McpServerStatus,
  type McpStatusListener,
  type McpToolCallReport,
  type McpToolProvenance,
  mcpSearchToolName,
} from "./mcp/registry.ts";
export {
  type AckSweep,
  ArcAirlock,
  type ArcAirlockOptions,
  type ArcCloseCandidate,
  type ArcCloseDigest,
  type ArcDelivery,
  ArcStillActiveError,
  type CandidateTriage,
  type CloseDecisions,
  IneligibleDeliveryError,
  MissingSuccessorError,
  type PrepareCloseOptions,
  type QuestionTriage,
  type RubricShortfall,
  UndecidedItemsError,
  UnknownTriageTargetError,
  WedgedSessionsError,
} from "./memory/arcs/airlock.ts";
export {
  type ArcBindingChange,
  type ArcBindingListener,
  ArcBindings,
} from "./memory/arcs/bindings.ts";
export {
  ArcOpenQuestions,
  type ArcOpenQuestionsOptions,
  type CapEvents,
  type CapOverflowChoice,
  defaultOpenQuestionCap,
  MissingOpenQuestionError,
  type OpenQuestion,
  OpenQuestionCapError,
  type OpenQuestionInput,
  type OpenQuestionStatus,
} from "./memory/arcs/questions.ts";
export {
  ArcRecall,
  type ArcRecallOptions,
  type ArcRecallOutcome,
  type ArcSearchHit,
  arcBootstrapLayer,
  defaultArcBoost,
  type MemoryLayerRef,
} from "./memory/arcs/recall.ts";
export {
  ArcExistsError,
  ArcNotActiveError,
  type ArcRecord,
  ArcRegistry,
  type ArcRegistryOptions,
  type ArcStatus,
  arcMocLink,
  InvalidArcSlugError,
  MissingArcError,
  validateArcSlug,
} from "./memory/arcs/registry.ts";
export {
  type BootstrapInjection,
  type BootstrapLayer,
  bootstrapMemory,
  type LayerBootstrap,
} from "./memory/bootstrap.ts";
export {
  type CitationChain,
  type CitationChainHop,
  type CitationEvent,
  CitationLedger,
  type CitationLedgerEvent,
  type CitationLedgerOptions,
  type CitationOutcome,
  citationChain,
  citationUsefulnessFeed,
  type LatencyEvent,
  type RecallEvent,
  type RecallSurface,
  type UsefulnessSink,
} from "./memory/citations.ts";
export {
  defaultFlushSettings,
  type FlushOutcome,
  type FlushSettings,
  isMemoryFlushPrompt,
  isNoReply,
  MemoryFlush,
  type MemoryFlushOptions,
  memoryFlushPrompt,
  noReplyToken,
  shouldFlush,
} from "./memory/flush.ts";
export {
  type Frontmatter,
  type FrontmatterValue,
  MalformedFrontmatterError,
} from "./memory/frontmatter.ts";
export {
  type CurationJudgmentPort,
  type CurationThresholds,
  type DailyEntryCandidate,
  defaultCurationThresholds,
  Gardener,
  type GardenerOptions,
  type PairRelation,
  type PairVerdict,
  type PromotionProposal,
  type ProposalRejection,
  type SweepOptions,
  type SweepReport,
} from "./memory/gardener.ts";
export {
  type DanglingLink,
  type EntityType,
  entityTypeSchema,
  entityTypes,
  type GraphEdge,
  type GraphNode,
  MemoryGraph,
  type OutlineEntry,
  type PageRankOptions,
  type Predicate,
  predicateSchema,
  predicates,
  type RankedEntity,
  type SkippedRelation,
} from "./memory/graph.ts";
export {
  MalformedInboxError,
  ReviewInbox,
  type ReviewInboxOptions,
  type ReviewItem,
  type ReviewItemDetail,
  ReviewItemNotFoundError,
  reviewKey,
} from "./memory/inbox.ts";
export {
  contentHash,
  type FileDelta,
  type LedgerEntry,
  type LedgerOp,
  type RevertOutcome,
} from "./memory/ledger.ts";
export { canonicalEntityPath, InvalidTitleError, titleKey } from "./memory/naming.ts";
export {
  memoryGetTool,
  memoryRecallTools,
  memorySearchTool,
  type RecallListener,
} from "./memory/recall-tools.ts";
export { type NamedSecret, redactForPersistence } from "./memory/redaction.ts";
export type { NoteRelations } from "./memory/search.ts";
export {
  type EmbeddingsPort,
  MemorySearch,
  type RetrievalSource,
  type SearchHit,
  type SearchLeg,
  type SearchObserver,
  type SearchOptions,
  type SearchOutcome,
} from "./memory/search.ts";
export {
  type BootstrapSelection,
  type DailyEntry,
  DuplicateTitleError,
  extractWikilinks,
  LedgerEntryNotFoundError,
  MalformedStagedItemError,
  MemoryInertError,
  MemoryStore,
  type MemoryStoreOptions,
  MissingNoteError,
  type Note,
  type NoteInput,
  type Provenance,
  type StagedItem,
  StagedItemNotFoundError,
  type StagedKind,
  type WriteResult,
} from "./memory/store.ts";
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
  type CostRollup,
  carriesUsage,
  costNanosOf,
  emptyCostRollup,
  formatCostNanos,
  groupCosts,
  knownCostNanos,
  type ModelRates,
  mergeCostRollups,
  ratesFor,
  type SessionCostSource,
  sessionCost,
  withTurnCost,
} from "./pricing.ts";
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
  BedrockExceptionError,
  type BedrockOptions,
  BedrockProvider,
} from "./providers/bedrock/bedrock.ts";
export {
  type AwsCredentials,
  credentialsFromEnv,
  regionFromEnv,
} from "./providers/bedrock/sigv4.ts";
export {
  type FetchLike,
  type OpenAiCompatibleOptions,
  OpenAiCompatibleProvider,
  ProviderHttpError,
  ProviderStreamError,
} from "./providers/openai.ts";
export {
  type OpenAiResponsesOptions,
  OpenAiResponsesProvider,
} from "./providers/openai-responses.ts";
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
  checkpointForPrompt,
  type FileEntry,
  type FileTrackingDetails,
  type LabelEntry,
  type MessageEntry,
  type ModelChangeEntry,
  type PromptCheckpoint,
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
export { fitTitle, kebabTitle, suggestTitle, type TitleContext } from "./titles.ts";
export { bashTool, detectShell, type Shell } from "./tools/bash.ts";
export { coreTools, type MemoryRecall } from "./tools/core.ts";
export { defineTool } from "./tools/define.ts";
export { editTool } from "./tools/edit.ts";
export { readTool } from "./tools/read.ts";
export { writeTool } from "./tools/write.ts";
export { findTool, type Tool, ToolNotFoundError } from "./tools.ts";

export const engineVersion = "0.0.1";
