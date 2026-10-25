import type {
  AgentContext,
  ArcStatus,
  AuditEntry,
  CacheMiss,
  CandidateTriage,
  ChangedPath,
  CompactionEntry,
  ContextEditEntry,
  ContextEditMark,
  CostRollup,
  DailyEntry,
  EffortLevel,
  FlushMark,
  InferenceBinding,
  LearningLevel,
  LedgerEntry,
  McpServerStatus,
  Message,
  ModelReference,
  Note,
  PermissionsView,
  PromptOrigin,
  Provenance,
  Provider,
  QuestionTriage,
  QueuedPrompt,
  QueueMove,
  Resolution,
  ResolutionFailure,
  RevertOutcome,
  SendBehavior,
  SessionBinding,
  SessionEntry,
  SettlePhase,
  SpillReference,
  StagedItem,
  SummaryMark,
  Usage,
  WriteResult,
} from "@keywork/engine";
import type {
  ActivePreset,
  AskScope,
  CompleteTheme,
  PermissionRule,
  PresetName,
  TrustDecision,
  WorkspaceAnchor,
} from "@keywork/shared";
import type { AnswerOutcome, AskVerdict, Denial, PendingAsk } from "./asks.ts";
import type { ByteRange, FileSlice, TreeListing } from "./files.ts";

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  lastActivityAt: string;
  messageCount: number;
  costNanos?: number;
  arc?: string;
  bot?: string;
  model?: string;
  thinking?: boolean;
  effort?: EffortLevel;
}

export interface SessionRow extends SessionSummary {
  live: boolean;
  working: boolean;
  waiting: WaitingAsks;
  changes?: ChangesSummary;
}

export interface WaitingAsks {
  asks: number;
  tools: string[];
}

export interface ChangesSummary {
  files: number;
  added: number;
  deleted: number;
}

export interface SessionDetail extends SessionSummary {
  cwd: string;
  live: boolean;
  messages: readonly Message[];
  summaries: readonly SummaryMark[];
  flushes: readonly FlushMark[];
  edits: readonly ContextEditMark[];
  asOf: number;
  parentSession?: string;
  forkedFrom?: ForkOrigin;
}

export interface ForkOrigin {
  sessionId?: string;
  removed: boolean;
}

export interface SessionLifecyclePort {
  remove(id: string): Promise<SessionSummary | Refusal>;
  trash(): Promise<readonly SessionSummary[]>;
  restore(id: string): Promise<SessionSummary | undefined>;
  discard(id: string): Promise<SessionSummary | undefined>;
  purge(): Promise<number>;
}

export type PromptOutcome = "accepted" | "missing";

export type InjectOutcome = "started" | "queued" | "missing";

export type AbortOutcome = "aborted" | "idle" | "missing";

export type Refusal = "missing" | "busy";

export type EntryRefusal = "missing" | "unknown-entry";

export interface SessionEntries {
  sessionId: string;
  name?: string;
  leafId: string | null;
  entries: readonly SessionEntry[];
  labels: Record<string, string>;
  activePath: readonly string[];
  journal: readonly string[];
}

export interface LabelOutcome {
  entryId: string;
  label: string | null;
}

export interface LeafOutcome {
  leafId: string | null;
}

export interface SessionTreePort {
  entries(id: string): Promise<SessionEntries | "missing">;
  fork(id: string, entryId: string): Promise<{ sessionId: string } | EntryRefusal>;
  label(id: string, entryId: string, label: string | null): Promise<LabelOutcome | EntryRefusal>;
  moveLeaf(id: string, entryId: string | null): Promise<LeafOutcome | Refusal | "unknown-entry">;
}

export interface ChangesReport {
  baseline: string;
  files: readonly ChangedPath[];
}

export interface FileSides {
  before: string | undefined;
  after: string | undefined;
}

export type ChangesRefusal = "missing" | "no-baseline";

export interface ChangesPort {
  list(id: string): Promise<ChangesReport | ChangesRefusal>;
  file(id: string, path: string): Promise<FileSides | ChangesRefusal>;
}

export interface SessionState {
  model?: string;
  thinking: boolean;
  effort?: EffortLevel;
  title: string;
  leafId: string | null;
  arc?: string;
  bot?: string;
  quiet: boolean;
  undoable: boolean;
  redoable: boolean;
}

export interface SessionSettlement {
  phase: SettlePhase | "requested";
  flushed: number;
  compacted: CompactionEntry | null;
  notices: readonly string[];
}

export interface SessionInference {
  bind(reference: string): Resolution;
  provider(binding: InferenceBinding): Provider;
}

export type ModelSwitch =
  | { model: ModelReference; notice: string }
  | { failure: ResolutionFailure };

export interface CompactionReport {
  compacted: CompactionEntry | null;
  notices: readonly string[];
}

export interface UndonePrompt {
  entryId: string;
  text: string;
}

export interface UndoReport {
  prompt: UndonePrompt | null;
  filesNote: string;
  undoable: boolean;
  redoable: boolean;
}

export interface RedoReport {
  restored: true;
  undoable: boolean;
  redoable: boolean;
}

export interface RestoreReport {
  turn: number;
  prompt: UndonePrompt;
  leafId: string | null;
  undoneTurns: number;
  files: readonly ChangedPath[];
  filesNote: string;
  undoable: boolean;
  redoable: boolean;
}

export interface RestorePreview {
  turn: number;
  prompt: UndonePrompt;
  undoneTurns: number;
  files: readonly ChangedPath[];
  others: readonly OtherSessionFiles[];
}

export interface OtherSessionFiles {
  sessionId: string;
  title: string;
  paths: readonly string[];
}

export interface ModelSpend {
  reference: string;
  turns: number;
  usage: Usage;
  rollup: CostRollup;
}

export interface CostReport {
  rollup: CostRollup;
  usage: Usage;
  modelId?: string;
  cacheMiss?: CacheMiss;
  models: readonly ModelSpend[];
}

export type ExportScope = "path" | "tree";

export type ExportOutcome = { html: string } | { file: string } | "missing" | "outside-scope";

export interface FlushReport {
  flushed: number;
  notices: readonly string[];
}

export interface ForgetReport {
  edit: ContextEditEntry;
}

export interface QueueReport {
  queued: readonly QueuedPrompt[];
}

export type QueueRefusal = "missing" | Exclude<QueueMove, "moved">;

export interface SessionQueuePort {
  setAside(id: string): Promise<readonly QueuedPrompt[] | "missing">;
  move(id: string, itemId: string, to: number): Promise<QueueReport | QueueRefusal>;
  cancel(id: string, itemId: string): Promise<QueueReport | "missing" | "unknown">;
}

export interface SpillSlice extends Omit<FileSlice, "path"> {
  spill: SpillReference;
}

export type SpillRefusal = "missing" | "unknown-spill";

export type PermissionsAnswer = PermissionsView & { quiet: string[] };

export interface PresetHost {
  active(): ActivePreset;
  apply(name: PresetName): Promise<void>;
}

export type PresetOutcome =
  | { from: ActivePreset; to: PresetName }
  | "needs-confirmation"
  | "unavailable";

export interface SessionHost {
  list(): Promise<readonly SessionRow[]>;
  read(id: string): Promise<SessionDetail | undefined>;
  create(): Promise<SessionSummary>;
  prompt(id: string, text: string, behavior?: SendBehavior): Promise<InjectOutcome>;
  inject(id: string, text: string, origin: PromptOrigin): Promise<InjectOutcome>;
  abort(id: string): Promise<AbortOutcome>;
  setModel(id: string, reference: string): Promise<ModelSwitch | Refusal>;
  setThinking(id: string, on: boolean): Promise<{ thinking: boolean } | "missing">;
  setEffort(
    id: string,
    level: EffortLevel | null,
  ): Promise<{ effort: EffortLevel | null } | Refusal>;
  compact(id: string, focus?: string): Promise<CompactionReport | Refusal>;
  undo(id: string): Promise<UndoReport | Refusal | "nothing">;
  redo(id: string): Promise<RedoReport | Refusal | "nothing">;
  restore(id: string, turn: number): Promise<RestoreReport | Refusal | "unknown-turn">;
  previewRestore(id: string, turn: number): Promise<RestorePreview | "missing" | "unknown-turn">;
  context(id: string): Promise<AgentContext | "missing">;
  cost(id: string): Promise<CostReport | "missing">;
  exportHtml(id: string, scope: ExportScope, out?: string): Promise<ExportOutcome>;
  rename(id: string, title: string): Promise<{ title: string } | "missing">;
  setQuiet(id: string, on: boolean): Promise<{ quiet: boolean } | "missing">;
  flush(id: string): Promise<FlushReport | Refusal>;
  forget(
    id: string,
    entryId: string,
    replacement?: string,
  ): Promise<ForgetReport | Refusal | "unknown-entry">;
  spill(id: string, spillId: string, range: ByteRange): Promise<SpillSlice | SpillRefusal>;
  applyPreset(name: PresetName, confirmed: boolean): Promise<PresetOutcome>;
  tree: SessionTreePort;
  changes: ChangesPort;
  queue: SessionQueuePort;
  asks(): Promise<readonly PendingAsk[]>;
  answerAsk(
    callId: string,
    verdict: AskVerdict,
    scope?: AskScope,
    denial?: Denial,
  ): Promise<AnswerOutcome>;
  permissions(): Promise<PermissionsAnswer>;
  grantWorkspaceRule(rule: PermissionRule): Promise<void>;
  grantSessionRule(sessionId: string, rule: PermissionRule): Promise<boolean>;
  revokeWorkspaceGrant(rule: PermissionRule): Promise<boolean>;
  revokeSessionGrant(sessionId: string, rule: PermissionRule): Promise<boolean>;
  close(): Promise<void>;
  memory?: MemoryPort;
  workspace?: WorkspacePort;
  mcp?: McpPort;
  arcs?: ArcsPort;
  bots?: BotsPort;
  workspaces?: WorkspacesPort;
  themes?: ThemesPort;
  lifecycle?: SessionLifecyclePort;
}

export interface MemoryPort {
  trusted(): boolean;
  overview(): Promise<MemoryOverview>;
  inbox(): Promise<readonly StagedItem[]>;
  approve(id: string): Promise<WriteResult | undefined>;
  discard(id: string): Promise<void>;
  notes(): Promise<readonly MemoryNoteRecord[]>;
  note(name: string, layer?: string): Promise<MemoryNoteDetail | undefined>;
  dailyDates(): Promise<readonly string[]>;
  daily(date: string): Promise<readonly DailyEntry[]>;
  ledger(): readonly LedgerEntry[];
  revert(ledgerId: string): Promise<RevertOutcome>;
  query(text: string, arc?: string): Promise<MemoryQueryOutcome>;
  airlock: ArcAirlockPort;
  subscribe?(listener: () => void): () => void;
}

export interface MemoryOverview {
  layers: readonly MemoryLayerRecord[];
  inbox: readonly StagedItem[];
  ledger: readonly LedgerEntry[];
  audit: readonly AuditEntry[];
  gardener?: GardenerActivity;
  airlocks: readonly ArcCloseDigestRecord[];
}

export interface MemoryLayerRecord {
  id: string;
  kind: "workspace" | "arc" | "user";
  label: string;
  arc?: string;
  prompt?: { budget: number; used: number };
}

export interface GardenerActivity {
  state: "idle" | "working" | "failed";
  sweptAt?: string;
}

export type MemoryNoteRecord = Note & {
  layer: string;
  file: string;
  injected: boolean;
  recalls: number;
};

export interface NoteRelation {
  name: string;
  predicate: string;
  direction: "out" | "in";
}

export type MemoryNoteDetail = MemoryNoteRecord & { relations: readonly NoteRelation[] };

export interface MemoryQueryHit {
  note: string;
  layer: string;
  ranks: Partial<Record<"lexical" | "semantic" | "graph", number>>;
  boost?: number;
  superseded: boolean;
}

export interface MemoryQueryOutcome {
  hits: MemoryQueryHit[];
  source: "lexical" | "hybrid" | "lexical-degraded";
  embeddings?: string;
}

export interface AirlockCandidateRecord {
  note: string;
  title: string;
  provenance: Provenance;
  eligible: boolean;
  shortfalls: string[];
  created?: string;
  choice?: CandidateTriage;
}

export interface AirlockQuestionRecord {
  title: string;
  provenance: Provenance;
  created?: string;
  choice?: QuestionTriage;
}

export interface ArcCloseDigestRecord {
  arc: string;
  candidates: AirlockCandidateRecord[];
  questions: AirlockQuestionRecord[];
  successor?: string;
  sweep?: { acked: number; wedged: number };
  direction?: string;
}

export type AirlockFinishOutcome =
  | { kind: "closed"; delivered: number; released: number; notice?: string }
  | { kind: "pending"; candidates: number; questions: number; wedged: number; notice?: string }
  | { kind: "undecided"; items: string[] }
  | { kind: "wedged"; sessions: string[] };

export interface ArcAirlockPort {
  digest(slug: string): Promise<ArcCloseDigestRecord | undefined>;
  triageCandidate(slug: string, note: string, choice: CandidateTriage): Promise<void>;
  triageQuestion(slug: string, title: string, choice: QuestionTriage): Promise<void>;
  deliverEligible(slug: string): Promise<number>;
  finish(slug: string, options?: { force?: boolean }): Promise<AirlockFinishOutcome>;
}

export type WorkspaceReadiness = "ready" | "undeclared" | "undecided" | "refused";

export interface WorkspaceReport {
  anchor: WorkspaceAnchor;
  identity: string;
  slug?: string;
  name?: string;
  declared: boolean;
  declarationFile?: string;
  contextDirs: readonly string[];
  missingContextDirs: readonly string[];
  focusDirs: readonly string[];
  vault?: string;
  trust: TrustDecision;
  readiness: WorkspaceReadiness;
}

export interface TrustGrant {
  trusted: true;
  root: string;
  vault: string;
  reopens: boolean;
  recomposed: boolean;
}

export interface WorkspacePort {
  report(): Promise<WorkspaceReport>;
  trust(): Promise<TrustGrant>;
  tree(path: string, hidden: boolean): Promise<TreeListing>;
  file(path: string, range: ByteRange): Promise<FileSlice>;
}

export interface McpPort {
  status(): Promise<McpServerStatus[]>;
  restart(name: string): Promise<void>;
  setEnabled(name: string, on: boolean): Promise<void>;
  listTools(name: string): Promise<string[]>;
  subscribe(listener: () => void): () => void;
}

export interface ArcSummary {
  slug: string;
  status: ArcStatus;
  created: string;
  sessions: number;
  theme?: string;
}

export type ArcCloseOutcome = Extract<AirlockFinishOutcome, { kind: "closed" | "pending" }>;

export interface ArcsPort {
  list(): Promise<ArcSummary[]>;
  create(slug: string): Promise<ArcSummary>;
  close(slug: string, direction?: string): Promise<ArcCloseOutcome>;
  abandon(slug: string): Promise<void>;
  bindSession(id: string, slug: string | null): Promise<SessionBinding | undefined>;
  setTheme(slug: string, theme: string | null): Promise<ArcSummary>;
  subscribe(listener: () => void): () => void;
}

export type BotScope = "project" | "user";

export interface BotEntry {
  name: string;
  sigil: string;
  source: BotScope;
  description?: string;
  model?: string;
  learning?: LearningLevel;
}

export interface BotSummary extends BotEntry {
  sessions: number;
  lastUsed?: string;
  costNanos?: number;
}

export interface BotDraft {
  slug: string;
  scope: BotScope;
  purpose?: string;
}

export interface BotsPort {
  list(): Promise<BotSummary[]>;
  create(draft: BotDraft): Promise<BotEntry>;
  bindSession(id: string, name: string | null): Promise<SessionBinding | undefined>;
}

export interface WorkspaceChoice {
  slug: string | undefined;
  name: string;
  declared: boolean;
  current: boolean;
  notes: number;
  focusDirs: readonly string[];
  sessions: number;
  lastUsed: number | undefined;
}

export interface WorkspacesPort {
  list(): Promise<WorkspaceChoice[]>;
  create(slug: string): Promise<void>;
  use(slug: string | undefined): Promise<void>;
  linkFocusDir(slug: string | undefined, dir: string): Promise<string>;
  unlinkFocusDir(slug: string | undefined, dir: string): Promise<void>;
}

export interface ThemesReport {
  themes: readonly CompleteTheme[];
  active: string;
  placeholders: readonly string[];
}

export interface ThemesPort {
  list(): Promise<ThemesReport>;
}

export class SurfaceUnavailableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "SurfaceUnavailableError";
  }
}

export class SessionBusyError extends Error {
  constructor() {
    super("a turn is running");
    this.name = "SessionBusyError";
  }
}

export class TrustRefusedError extends Error {
  constructor(root: string) {
    super(`${root} is marked untrusted; keywork trust in a terminal reverses that`);
    this.name = "TrustRefusedError";
  }
}
