export {
  Agent,
  type AgentOptions,
  addUsage,
  type ConfirmingGate,
  type PermissionResolver,
  QueuedPromptCancelledError,
  type SendOptions,
  type ToolGuard,
  type ToolPermission,
  type ToolSource,
  type TurnSettler,
} from "./agent.ts";
export { type EngineEvents, EventBus, type QueuedPrompt, type SendBehavior } from "./bus.ts";
export {
  declaredCapabilitiesFor,
  type InputModality,
  type ModelCapabilities,
  type ModelCapabilityDeclaration,
  UndeclaredCapabilityError,
  undeclaredCapabilities,
  withDeclaredCapabilities,
} from "./capabilities.ts";
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
  LayerRoots,
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
  type AdapterOptions,
  type CredentialMaterial,
  CredentialMaterialError,
  type CredentialVault,
  modelReferenceOf,
  providerFor,
} from "./inference/adapters.ts";
export {
  endpointScheme,
  formatReference,
  isLoopbackEndpoint,
  parseReference,
  sameReference,
} from "./inference/references.ts";
export { InferenceRegistry } from "./inference/registry.ts";
export type { CatalogEntry } from "./inference/resolution.ts";
export {
  type CredentialHandle,
  type CredentialState,
  type InferenceBinding,
  InvalidRegistrationError,
  type ModelOrigin,
  type ModelReference,
  type ModelSpec,
  type Protocol,
  type ProviderRegistration,
  protocols,
  type RequestDecorations,
  type Resolution,
  ResolutionError,
  type ResolutionFailure,
  type ResolutionFailureCode,
  type ResolutionRequest,
} from "./inference/types.ts";
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
  connectHttpServer,
  type HttpConnectOptions,
  type HttpServerSpec,
} from "./mcp/http.ts";
export type {
  ConnectServer,
  McpServerState,
  McpServerStatus,
  McpTransport,
} from "./mcp/reconciler.ts";
export {
  defaultRestartDelaysMs,
  isMcpBackedTool,
  type McpBackedTool,
  McpRegistry,
  McpRegistryClosedError,
  type McpRegistryOptions,
  McpServerNotFoundError,
  type McpStatusListener,
  type McpToolCallReport,
  type McpToolProvenance,
} from "./mcp/registry.ts";
export { mcpSearchToolName } from "./mcp/tool-search.ts";
export {
  anchorFrontmatter,
  type CheckpointAnchor,
  type CheckpointAnchorInputs,
  checkpointAnchor,
  readAnchor,
} from "./memory/anchors.ts";
export {
  type AckSweep,
  ArcAirlock,
  type ArcAirlockOptions,
  type ArcCloseCandidate,
  type ArcCloseDigest,
  type ArcDelivery,
  type ArcReview,
  ArcStillActiveError,
  type CandidateTriage,
  type CloseDecisions,
  deliveryRecordTitle,
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
export { type ClosingAgentOptions, closingJudgment } from "./memory/arcs/closing.ts";
export { ArcCloseDraft } from "./memory/arcs/draft.ts";
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
  arcLayer,
  defaultArcBoost,
  type MemoryLayerRef,
  searchHitLayer,
  workspaceLayer,
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
  type AskAnswer,
  type AskEvent,
  AskGateLedger,
  type AskGateLedgerOptions,
  defaultPreferenceThreshold,
  toolShape,
} from "./memory/ask-gate.ts";
export { type AuditEntry, auditLine, parseAuditLog } from "./memory/audit.ts";
export {
  type BootstrapInjection,
  type BootstrapLayer,
  type BootstrapSelection,
  type BootstrapSource,
  bootstrapMemory,
  type LayerBootstrap,
  mostUsefulFirst,
  selectWithinBudget,
} from "./memory/bootstrap.ts";
export {
  type CitationChain,
  type CitationChainHop,
  type CitationEvent,
  CitationLedger,
  type CitationLedgerEvent,
  type CitationLedgerOptions,
  type CitationOutcome,
  citationAuditEvent,
  citationChain,
  citationUsefulnessFeed,
  type LatencyEvent,
  parseCitationEvents,
  type RecallEvent,
  type RecallSurface,
  type RecallTap,
  type UsefulnessSink,
} from "./memory/citations.ts";
export {
  backtrackFlushClause,
  type FlushOutcome,
  flushPrompt,
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
  contentHash,
  type FileDelta,
  type LedgerEntry,
  type LedgerOp,
  type RevertOutcome,
} from "./memory/ledger.ts";
export { canonicalEntityPath, InvalidTitleError, titleKey } from "./memory/naming.ts";
export {
  type DailyEntry,
  extractWikilinks,
  InvalidDailyDateError,
  isEntityPath,
  type Note,
  type NoteWriteTarget,
  noteName,
  noteWriteTarget,
  type Provenance,
  parseDailyEntries,
  provenances,
  wikilinkTarget,
} from "./memory/notes.ts";
export {
  type ActionRecallOptions,
  actionRecallBudget,
  actionRecallDefaults,
  actionSubject,
  pointOfActionRecall,
} from "./memory/point-of-action.ts";
export {
  memoryGetTool,
  memoryRecallTools,
  memorySearchTool,
  type RecallListener,
} from "./memory/recall-tools.ts";
export { type NamedSecret, redactForPersistence } from "./memory/redaction.ts";
export {
  type GatherReturnDeltaOptions,
  gatherReturnDelta,
  type ReturnDeltaInputs,
  returnDelta,
} from "./memory/return-delta.ts";
export type { NoteRelations } from "./memory/search.ts";
export {
  type EmbeddingsPort,
  type LegRanks,
  MemorySearch,
  type MemorySearcher,
  type RetrievalSource,
  type SearchHit,
  type SearchLeg,
  type SearchObserver,
  type SearchOptions,
  type SearchOutcome,
} from "./memory/search.ts";
export {
  describeStaged,
  isStagedWrite,
  MalformedStagedItemError,
  type ReviewProposal,
  reviewKey,
  reviewProposalSchema,
  type StagedItem,
  StagedItemNotFoundError,
  type StagedKind,
  type StagedReview,
  type StagedWrite,
  type StagedWriteKind,
} from "./memory/staging.ts";
export {
  DuplicateTitleError,
  defaultLedgerCapacity,
  LedgerEntryNotFoundError,
  MemoryInertError,
  MemoryStore,
  type MemoryStoreOptions,
  MissingNoteError,
  type NoteInput,
  type WriteResult,
} from "./memory/store.ts";
export {
  isMissingFileError,
  PathOutsideVaultError,
  ReservedPathError,
  VaultFiles,
  writeFileAtomic,
} from "./memory/vault-files.ts";
export {
  type ImagePart,
  type Message,
  messageText,
  ownedBy,
  type Part,
  type ProviderStateOwner,
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
export {
  MockProvider,
  type MockProviderOptions,
  textTurn,
  toolCallTurn,
} from "./mock-provider.ts";
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
export {
  declaredContextWindow,
  type Provider,
  type ProviderRequest,
  type ToolDefinition,
  type TurnDelta,
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
  ProviderEmptyResponseError,
  ProviderHttpError,
  ProviderStreamError,
} from "./providers/errors.ts";
export {
  type OpenAiCompatibleOptions,
  OpenAiCompatibleProvider,
} from "./providers/openai.ts";
export {
  type OpenAiResponsesOptions,
  OpenAiResponsesProvider,
} from "./providers/openai-responses.ts";
export { RetryingProvider, type RetryOptions, type Sleep } from "./providers/retry.ts";
export {
  type AuthHeaders,
  bearerHeaders,
  type FetchLike,
  postForStream,
  type StreamingPost,
} from "./providers/transport.ts";
export {
  RepoMap,
  type RepoMapFacts,
  type RepoMapOptions,
  repoMapTokenBudget,
  repoMapTokenCap,
} from "./repomap/map.ts";
export { type IgnoreFileProblem, scanWorkspace, type WorkspaceScan } from "./repomap/scan.ts";
export {
  type CompactionOptions,
  type CompactionPlan,
  compactSession,
  estimateContextTokens,
  estimateConversationTokens,
  planCompaction,
  serializeConversation,
} from "./session/compaction.ts";
export {
  assumedContextWindow,
  type ContextBudget,
  type ContextReading,
  compactionDue,
  contextBudgetFor,
  contextFullness,
  flushDue,
  formatTokenCount,
  readContext,
  reserveCaps,
} from "./session/context-budget.ts";
export {
  type ArcBindingEntry,
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
export {
  type ContextInjection,
  type ExtensionState,
  extensionState,
  type InjectionSource,
  type JournalEvent,
  type JournalTap,
  journalEvents,
  type PermissionDecision,
  type PermissionGate,
  type PermissionVerdict,
  recordJournalEvent,
  replayJournalEntry,
  tapJournal,
} from "./session/journal.ts";
export { replaySession } from "./session/replay.ts";
export {
  type CompactNowOptions,
  compactNow,
  readStore,
  type SettleOptions,
  settleTurn,
  type TurnSettlement,
} from "./session/settle.ts";
export {
  type BranchSummaryInput,
  type CompactionInput,
  type SessionStats,
  SessionStore,
} from "./session/store.ts";
export { fitTitle, kebabTitle, suggestTitle, type TitleContext } from "./titles.ts";
export { bashTool, detectShell, type Shell } from "./tools/bash.ts";
export { confinedPath, scopeContains, type ToolScope, toolScope } from "./tools/confine.ts";
export { type CoreToolOptions, coreTools, type MemoryRecall } from "./tools/core.ts";
export { defineTool } from "./tools/define.ts";
export { editTool } from "./tools/edit.ts";
export { readTool } from "./tools/read.ts";
export {
  persistentBashTool,
  type ShellRunOptions,
  ShellSession,
} from "./tools/shell-session.ts";
export { writeTool } from "./tools/write.ts";
export { findTool, type Tool, ToolNotFoundError } from "./tools.ts";

export { engineVersion } from "./version.ts";
