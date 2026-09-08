export { type AppOptions, type NoticeSource, runApp } from "./app.ts";
export type { FocusedArcPort } from "./arc-commands.ts";
export {
  type ArcPicker,
  type ArcPickerChoice,
  type ArcPickerRow,
  arcChoiceOf,
  arcPickerOver,
  describeArcRow,
} from "./arc-picker.ts";
export {
  type AirlockCandidateView,
  type AirlockDigestView,
  type AirlockFinishOutcome,
  type AirlockQuestionView,
  type AirlockSweepView,
  type ArcAirlockPort,
  type ArcCloseOutcome,
  type ArcOrdinals,
  type ArcStatus,
  type ArcSummary,
  type ArcsPort,
  activeFirst,
  arcInk,
  arcOrdinalsOf,
  arcSlugProblem,
  arcTag,
  type CandidateChoice,
  describeCloseOutcome,
  describeFinishOutcome,
  isArcSlug,
  type QuestionChoice,
  suggestArcSlug,
} from "./arcs.ts";
export { ArcsPane, type ArcsPaneOptions } from "./arcs-pane.ts";
export type { ArcGroupKey, ArcGroupRow, ArcsLevel } from "./arcs-pane-model.ts";
export type { FocusedBotPort } from "./bot-commands.ts";
export {
  type BotPicker,
  type BotPickerChoice,
  type BotPickerRow,
  botChoiceOf,
  botPickerOver,
  describeBotRow,
} from "./bot-picker.ts";
export {
  type BotDraft,
  type BotEntry,
  type BotScope,
  type BotSummary,
  type BotsPort,
  botLabel,
  botSlugProblem,
  botsHint,
  describeBots,
  isBotSlug,
} from "./bots.ts";
export {
  border,
  type CapabilityProfile,
  type ColorDepth,
  density,
  detectCapabilities,
  type GlyphSupport,
  type GlyphTier,
  resolveMark,
  resolveRamp,
  sparkline,
  type TerminalEnvironment,
  type TerminalId,
  type TieredMark,
  type TieredRamp,
  tile,
} from "./capability.ts";
export {
  barCells,
  contextGauge,
  contextReadout,
  type GaugeOptions,
  type GaugeStyle,
  gaugeStyleFor,
  type InstrumentTier,
} from "./context-gauge.ts";
export type { CompactionHook, ForkOutcome, Titler } from "./conversation-model.ts";
export type { TranscriptElevation } from "./conversation-pane.ts";
export { type CrashLogFacts, crashLogFacts, crashLogFile } from "./crash-log.ts";
export {
  type ChangedFile,
  checkpointBaseline,
  type DiffBaseline,
  type DiffPort,
  type GitRunner,
  gitHeadBaseline,
  noBaselineNotice,
  type ReadWorkingFile,
  untrustedNotice,
  workingFileReader,
} from "./diff-model.ts";
export type {
  ConversationTarget,
  ExtensionCommandEntry,
  ExtensionsPort,
} from "./extension-commands.ts";
export {
  type Flavor,
  FlavorSwitch,
  keyworkNightFlavor,
  registerFlavorCommands,
  startupFlavors,
  themeOf,
} from "./flavor.ts";
export type { CheckpointsPort } from "./fork.ts";
export {
  type Highlighter,
  highlightedLanguages,
  highlighterFor,
  type SyntaxClass,
  type SyntaxSpan,
} from "./highlighter.ts";
export type {
  ConnectionDraft,
  ConnectionProtocol,
  ConnectionsPort,
  ConnectionTarget,
  CredentialChoice,
  InferencePort,
  ModelChoice,
  RemovalReceipt,
  ResolutionNotice,
  SavedConnection,
  VerificationOutcome,
} from "./inference-port.ts";
export {
  applyKeybindings,
  type KeybindingSource,
  resolveBindings,
  watchKeybindings,
} from "./keybindings.ts";
export type { BindingSpec } from "./keymap.ts";
export {
  type MarkdownRow,
  type MarkdownSpan,
  type MarkdownTone,
  markdownRowText,
  renderMarkdown,
} from "./markdown.ts";
export {
  assumedGlyphs,
  defaultPageMarks,
  type PageMarks,
  pageMarkFamilies,
  pageMarks,
  type VoiceStamps,
} from "./marks.ts";
export {
  type Headline,
  type HeadlineFace,
  type HeadlineFrame,
  headline,
  type MastheadMoment,
  wearsMasthead,
} from "./masthead.ts";
export { McpPane, type McpPanePort, mcpDropWatcher } from "./mcp-pane.ts";
export type {
  McpProgress,
  McpServerState,
  McpServerView,
} from "./mcp-pane-model.ts";
export { MemoryPane, type MemoryPaneOptions, type MemoryPanePort } from "./memory-pane.ts";
export type {
  CuringStage,
  GardenerActivityView,
  InboxItemView,
  InboxKind,
  LedgerEventView,
  MemoryLayerKind,
  MemoryLayerView,
  MemoryLensState,
  MemoryNoteView,
  MemoryPaneInputs,
  MemoryProvenance,
  MemoryQueryHit,
  MemoryQueryOutcome,
  NoteRelationView,
  PromptBudgetView,
  QueryLeg,
  QuerySource,
} from "./memory-pane-model.ts";
export { type DigestTreatment, type GardenHeat, noteHeat } from "./memory-rows.ts";
export {
  Animator,
  type AnimatorOptions,
  type CancelTimer,
  inkAt,
  type MotionSpec,
  type Scheduler,
  type StepShape,
  stepProgress,
  type Tempo,
  type TempoSpec,
  tempos,
} from "./motion.ts";
export { parseColorReplies, type TerminalColors } from "./osc.ts";
export type { PresetsPort } from "./overlays/index.ts";
export {
  type PageGrammar,
  type PageThresholdOverrides,
  type PageThresholds,
  type PageTier,
  pageTierThresholds,
  proseWidth,
  resolvePage,
  resolvePageThresholds,
} from "./page.ts";
export type { LifecycleState } from "./pane.ts";
export type { ArcOrigin, PaneOrigin } from "./pane-kinds.ts";
export type { WorkspacePort } from "./restore-plan.ts";
export type {
  AfterTurn,
  AgentFactory,
  AgentSeams,
  Compactor,
  SessionAttachment,
  SessionPort,
  SessionTurn,
  ThinkingSwitch,
} from "./session-attachment.ts";
export type { SessionTreeView } from "./session-tree-model.ts";
export type { SessionTreePaneSeams, SessionTreePort } from "./session-tree-pane.ts";
export {
  type OverviewRow,
  type SessionGroupBy,
  type SessionGroupRow,
  type SessionLiveness,
  type SessionOverviewItem,
  type SessionOverviewRow,
  type SessionPresence,
  sessionGroupings,
} from "./sessions-overview-model.ts";
export { guardedShellEscape, type ShellEscapePort, type ShellEscapeSeams } from "./shell-escape.ts";
export {
  type SlugInk,
  type SlugPart,
  type SlugRole,
  slugChunks,
  slugInk,
  slugParts,
  slugWords,
} from "./slug-ink.ts";
export {
  type ColorTransport,
  colorsFromEnv,
  detectTerminalColors,
  queryTerminalColors,
  stdioColorTransport,
  systemFlavor,
  systemFlavorName,
} from "./system-theme.ts";
export { keyworkNight, resolveTheme, type Theme, type ThemeOverrides } from "./theme.ts";
export { curatedTips, rotatingTip, type Tip, type TipSignals, tipRotationMs } from "./tips.ts";
export { type TitleBarState, type TitleSpan, titleBar, titleSpans } from "./title-bar.ts";
export type { FocusOutline } from "./view/frame.ts";
export {
  describeWorkspaceRow,
  type WorkspaceChoice,
  type WorkspacePicker,
  type WorkspacePickerChoice,
  type WorkspacePickerRow,
  type WorkspacesPort,
  workspaceChoiceOf,
  workspacePickerOver,
} from "./workspace-picker.ts";
export {
  readinessNotice,
  setupPrompt,
  type WorkspaceReadiness,
  type WorkspaceSetupPort,
  type WorkspaceSetupReceipt,
} from "./workspace-setup.ts";
export type { WorkspaceState } from "./workspace-state.ts";
export { WorkspacesPane, type WorkspacesPaneOptions } from "./workspaces-pane.ts";
export type {
  FocusDirRow,
  WorkspaceRow,
  WorkspacesLevel,
} from "./workspaces-pane-model.ts";
