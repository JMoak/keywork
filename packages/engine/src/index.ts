export {
  Agent,
  type AgentOptions,
  addUsage,
  type Confirmation,
  type ConfirmingGate,
  type DelegatedOutcome,
  type DelegatedTurn,
  type PermissionResolver,
  QueuedPromptCancelledError,
  type SendOptions,
  type SpillSource,
  type ToolBatchSettler,
  type ToolGuard,
  type ToolPermission,
  type ToolSource,
  type TurnDelegate,
  type TurnSettler,
} from "./agent.ts";
export {
  type AgentHooks,
  proceedWith,
  type ToolCallRuling,
  toolsThroughHooks,
} from "./agent-hooks.ts";
export {
  type EngineEvents,
  EventBus,
  type PromptOrigin,
  type QueuedPrompt,
  type SendBehavior,
} from "./bus.ts";
export {
  declaredCapabilitiesFor,
  type InputModality,
  type ModelCapabilities,
  type ModelCapabilityDeclaration,
  UndeclaredCapabilityError,
  undeclaredCapabilities,
  withDeclaredCapabilities,
} from "./capabilities.ts";
export {
  type ChangedPath,
  type CheckpointReads,
  Checkpoints,
  type CheckpointsOptions,
  UnknownCheckpointError,
} from "./checkpoints.ts";
export {
  type BusEvent,
  coalesceDeltas,
  type DeltaCoalescer,
  type EventSink,
  frameTick,
  frameTickMs,
  type TickScheduler,
} from "./coalesce.ts";
export {
  type DiagnosticsLevel,
  type DiagnosticsLine,
  DiagnosticsLog,
  debugEnabled,
  debugLogFile,
  redactSecrets,
} from "./diagnostics.ts";
export {
  type BotDefinition,
  type BotLoad,
  botFileName,
  botsDir,
  defaultSigil,
  type LearningLevel,
  learningLevels,
  loadBots,
  narrowedPermissions,
  restrictTools,
} from "./extensions/bots.ts";
export {
  discoverExtensions,
  type ExtensionCandidate,
  type ExtensionDiscovery,
  type ExtensionLoadReport,
  type ExtensionRoots,
  extensionsConvention,
  importExtension,
  loadExtensions,
  type SkippedExtensionLayer,
  untrustedProjectReason,
} from "./extensions/discover.ts";
export {
  appendExtensionEntry,
  type ExtensionEntry,
  extensionEntries,
  extensionEntryOf,
  extensionEntryType,
} from "./extensions/extension-entries.ts";
export {
  type CustomEntryDelivery,
  type ExtensionApi,
  type ExtensionCommand,
  type ExtensionDefinition,
  type ExtensionFactory,
  type ExtensionFlag,
  type ExtensionLogger,
  type ExtensionLogLevel,
  type ExtensionShortcut,
  type ExtensionSource,
  type ExtensionTeardown,
  type HookHandler,
  type HookHandlers,
  type HookName,
  type HookPayload,
  type HookResult,
  type Hooks,
  isWiredHook,
  type SessionEndReason,
  type SessionStartReason,
  type ToolCallDecision,
  type ToolResultReport,
  type TypedOnlyHook,
  typedOnlyHooks,
  type WiredHook,
  wiredHooks,
} from "./extensions/hooks.ts";
export {
  defaultHookTimeoutMs,
  type ExtensionFailure,
  ExtensionHost,
  type ExtensionHostOptions,
  type ExtensionNotice,
  type ExtensionStanding,
  type ExtensionStatus,
  HookTimeoutError,
  type OwnedCommand,
  type OwnedFlag,
  type OwnedShortcut,
  type SessionStartOptions,
  UnknownExtensionCommandError,
} from "./extensions/host.ts";
export type {
  ExtensionLoadFailure,
  LayerRoots,
  LayerSource,
} from "./extensions/layers.ts";
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
  bundledSkillsRoot,
  discoverSkills,
  discoverSkillsUnder,
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
export { KeepAwake, keepAwake } from "./keep-awake.ts";
export {
  type DiagnosticsObserverOptions,
  type DiagnosticsPublication,
  diagnosticsObserver,
} from "./lsp/after-save.ts";
export { diagnosticsBlock } from "./lsp/format.ts";
export { resolveOnPath, type SpawnLike } from "./lsp/path.ts";
export {
  type Diagnostic,
  defaultLanguageBudgets,
  type IdleScheduler,
  idleLanguageFacts,
  type LanguageBudgets,
  type LanguageFacts,
  type LanguagePort,
  type LanguagePortOptions,
  type LanguageServerFact,
  languagePort,
  type ServerState,
} from "./lsp/port.ts";
export {
  builtInLanguageServers,
  type LanguageServerSetting,
  type LanguageServerSpec,
  type LanguageServerTable,
  languageOf,
  languageServersFor,
} from "./lsp/servers.ts";
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
export {
  type ClosingAgentOptions,
  type ClosingSubject,
  closingJudgment,
} from "./memory/arcs/closing.ts";
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
  botLayer,
  defaultArcBoost,
  isLayeredHit,
  type LayeredSearchHit,
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
  BotRecall,
  type BotRecallOptions,
  type BotRecallOutcome,
  botBootstrapLayer,
  defaultBotBoost,
} from "./memory/bots/recall.ts";
export {
  type BotLayerRecord,
  type BotLayerStatus,
  BotRegistry,
  type BotRegistryOptions,
  botGenesisFile,
  MissingBotLayerError,
  validateBotSlug,
} from "./memory/bots/registry.ts";
export {
  proposeSkillGenesis,
  rememberedFingerprints,
  type SkillGenesisReport,
} from "./memory/bots/skill-genesis.ts";
export {
  type BotSweepOptions,
  type BotSweepReport,
  type BotSweepSkip,
  botSweepTokenBudget,
  sweepBotLayer,
} from "./memory/bots/sweep.ts";
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
  checkDrift,
  type DiffChanges,
  type DriftAssessment,
  type DriftCheckOptions,
  type DriftEvidence,
  type DriftFinding,
  type DriftJudgmentPort,
  type DriftReport,
  driftAuditEvent,
  driftJudgment,
  touchedNotes,
} from "./memory/drift.ts";
export {
  type BotFlushTarget,
  type BotLearnings,
  backtrackFlushClause,
  botFlushClause,
  botLinePrefix,
  type FlushOutcome,
  flushPrompt,
  isMemoryFlushPrompt,
  isNoReply,
  MemoryFlush,
  type MemoryFlushOptions,
  memoryFlushPrompt,
  noReplyToken,
  partitionBotLines,
  shouldFlush,
} from "./memory/flush.ts";
export {
  type ForgetEntry,
  type ForgetPlan,
  type ForgetRefusal,
  isEmptyPlan,
  planForget,
  stageForget,
} from "./memory/forget.ts";
export {
  type Frontmatter,
  type FrontmatterValue,
  MalformedFrontmatterError,
  serializeDocument,
} from "./memory/frontmatter.ts";
export {
  type CurationJudgmentPort,
  type CurationThresholds,
  type DailyEntryCandidate,
  defaultCurationThresholds,
  entryTokens,
  Gardener,
  type GardenerOptions,
  type PairRelation,
  type PairVerdict,
  type PromotionProposal,
  type ProposalRejection,
  type SkillEvidence,
  type SkillEvidenceEntry,
  type SkillReviewReason,
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
  botMocLink,
  botMocName,
  type DailyEntry,
  type DriftStamp,
  type DriftVerdict,
  driftStampOf,
  extractWikilinks,
  InvalidDailyDateError,
  isDriftVerdict,
  isEntityPath,
  learnedByLink,
  learnedBySlug,
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
  compareAgainstMemoryOff,
  memoryOffControl,
  type ProbeCase,
  type ProbeComparison,
  type ProbeCorpus,
  type ProbeHops,
  type ProbeMetrics,
  type ProbeOptions,
  probeCorpusStub,
  runRecallProbe,
} from "./memory/recall-probe.ts";
export {
  memoryGetTool,
  memoryRecallTools,
  memorySearchTool,
  type RecallListener,
} from "./memory/recall-tools.ts";
export { type NamedSecret, redactForPersistence } from "./memory/redaction.ts";
export {
  type BotIdentity,
  type GatherReturnDeltaOptions,
  gatherReturnDelta,
  type ReturnDeltaInputs,
  returnDelta,
} from "./memory/return-delta.ts";
export type { NoteRelations } from "./memory/search.ts";
export {
  type EmbeddingsPort,
  type IndexReconciliation,
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
  type SpillReference,
  type TextPart,
  type ThinkingPart,
  type ToolCallPart,
  type ToolResultPart,
  textMessage,
  toolCalls,
  type Usage,
  type VisibleThinkingPart,
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
  retirementOf,
  type SessionCostSource,
  sessionCost,
  withTurnCost,
} from "./pricing.ts";
export { processExists } from "./proc.ts";
export {
  buildSystemPrompt,
  loadProjectInstructions,
  type SystemPromptOptions,
} from "./prompt.ts";
export {
  type CacheDiagnostics,
  type CacheMiss,
  type DoneDelta,
  declaredContextWindow,
  type EffortChange,
  type EffortLevel,
  effortInForce,
  effortLevels,
  isEffortLevel,
  type Provider,
  type ProviderRequest,
  type ToolAddition,
  type ToolDefinition,
  type TurnDelta,
} from "./provider.ts";
export {
  AnthropicApiError,
  type AnthropicOptions,
  AnthropicProvider,
  anthropicHeaders,
  anthropicVersion,
  defaultMaxOutputTokens,
} from "./providers/anthropic.ts";
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
  type BindingEntry,
  type BranchSummaryEntry,
  type CompactionEntry,
  type ContextEditEntry,
  type ContextReplacement,
  type CustomEntry,
  type CustomMessageEntry,
  checkpointForPrompt,
  describeBinding,
  describeContextEdit,
  type EffortChangeEntry,
  type FileEntry,
  type FileTrackingDetails,
  foldBinding,
  isContextEditable,
  type LabelEntry,
  type MessageEntry,
  type ModelChangeEntry,
  type PromptCheckpoint,
  type SessionBinding,
  type SessionEntry,
  type SessionHeader,
  type SessionInfoEntry,
  type SessionTreeNode,
  sessionFormatVersion,
  type ThinkingLevelChangeEntry,
} from "./session/entries.ts";
export {
  type AskRule,
  type ContextInjection,
  type ExtensionState,
  extensionState,
  type InjectionSource,
  type JournalEvent,
  type JournalTap,
  journalEvents,
  type PermissionAsk,
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
  type SettlePhase,
  settleTurn,
  type TurnSettlement,
} from "./session/settle.ts";
export {
  type BoundedToolOutput,
  type ByteRange,
  boundToolOutput,
  defaultToolOutputBudget,
  elisionMarker,
  removeSessionFiles,
  SpillStore,
  spillDirFor,
} from "./session/spill.ts";
export {
  type BranchSummaryInput,
  type CompactionInput,
  type SessionStats,
  SessionStore,
} from "./session/store.ts";
export {
  type AgentAuthoredSkill,
  authoredByKey,
  authorOf,
  claimAgentAuthored,
  keyworkAuthor,
  ProtectedSkillError,
  SkillAlreadyExistsError,
} from "./skills/authorship.ts";
export {
  type ArchivedSkill,
  agentActor,
  archiveCandidates,
  type CurationCandidate,
  type CurationThresholds as SkillCurationThresholds,
  curatorActor,
  defaultSkillCurationThresholds,
  isPinned,
  SkillArchive,
  type SkillArchiveOptions,
  type SkillLedgerAction,
  type SkillLedgerEntry,
  type SkillVersion,
  SkillVersionNotFoundError,
  skillArchiveDirName,
  skillLedgerActions,
  skillLedgerFileName,
  userActor,
  withPin,
} from "./skills/curator.ts";
export {
  type CommandOccurrence,
  commandSequenceOf,
  genesisRecurrenceFloor,
  genesisSequenceFloor,
  type RecurringSequence,
  recurringSequences,
  type SkillProposal,
  sequenceFingerprint,
  skillBodyFor,
  skillDescriptionFor,
  skillNameFor,
  skillProposalFor,
} from "./skills/genesis.ts";
export {
  type ArchiveOutcome,
  type CurationOptions,
  type CurationOutcome,
  PinnedSkillError,
  ReferenceOutsideSkillError,
  SkillArchiveUnavailableError,
  type SkillChange,
  type SkillChangeKind,
  type SkillEvidenceRow,
  type SkillGenesis,
  SkillGenesisUnavailableError,
  type SkillHistory,
  SkillLibrary,
  type SkillLibraryOptions,
  SkillPatchError,
  type SkillView,
  UnknownSkillError,
} from "./skills/library.ts";
export {
  readSkillTelemetry,
  type SkillActivity,
  type SkillEventCounts,
  SkillTelemetry,
  type SkillTelemetryEvent,
  type SkillTelemetryOptions,
  type SkillTelemetrySnapshot,
  skillTelemetryEvents,
} from "./skills/telemetry.ts";
export {
  clippedToBudget,
  defaultSkillOutputBudget,
  type SkillToolOptions,
  skillLibraryTools,
} from "./skills/tools.ts";
export {
  fitTitle,
  kebabTitle,
  suggestBotName,
  suggestTitle,
  type TitleContext,
} from "./titles.ts";
export {
  type AfterSave,
  annotatedResult,
  type ComposeAfterSaveOptions,
  composeAfterSave,
} from "./tools/after-save.ts";
export { bashTool, detectShell, type Shell } from "./tools/bash.ts";
export { confinedPath, scopeContains, type ToolScope, toolScope } from "./tools/confine.ts";
export { type CoreToolOptions, coreTools, type MemoryRecall } from "./tools/core.ts";
export { defineTool } from "./tools/define.ts";
export { editTool } from "./tools/edit.ts";
export {
  interactiveShell,
  type PtyChild,
  type PtyRuntimeFacts,
  type PtySize,
  type PtySupport,
  probePtySupport,
  ptyUnavailableInRuntime,
  ptyUnavailableOnWindows,
  realPtyRuntimeFacts,
} from "./tools/pty.ts";
export { readTool } from "./tools/read.ts";
export {
  type InteractiveShell,
  openInteractiveShell,
  persistentBashTool,
  type ShellRunOptions,
  ShellSession,
} from "./tools/shell-session.ts";
export { writeTool } from "./tools/write.ts";
export { findTool, type Tool, ToolNotFoundError } from "./tools.ts";

export { engineVersion } from "./version.ts";
