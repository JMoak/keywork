import type {
  ArcStatus,
  AuditEntry,
  CacheMiss,
  ChangedPath,
  CheckpointReads,
  CompactionEntry,
  ContextReading,
  CostRollup,
  CuringStage,
  DailyEntry,
  EffortLevel,
  LedgerEntry,
  McpServerStatus,
  Message,
  ModelReference,
  Note,
  PermissionsView,
  PromptOrigin,
  Provenance,
  Provider,
  ResolutionFailure,
  RevertOutcome,
  SendBehavior,
  SessionEntry,
  StagedItem,
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
} from "@keywork/shared";
import type { AnswerOutcome, AskVerdict, PendingAsk } from "./asks.ts";

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  lastActivityAt: string;
  messageCount: number;
  model?: string;
  thinking?: boolean;
  effort?: EffortLevel;
  costNanos?: number;
  arc?: string;
  bot?: string;
}

export interface SessionDetail extends SessionSummary {
  cwd: string;
  live: boolean;
  messages: readonly Message[];
  asOf: number;
}

export interface SessionEntries {
  sessionId: string;
  name?: string;
  leafId: string | null;
  entries: readonly SessionEntry[];
  labels: Readonly<Record<string, string>>;
  activePath: readonly string[];
}

export interface SessionChanges {
  baseline: string;
  files: readonly ChangedPath[];
}

export type ChangedFileNote = "binary" | "new" | "deleted" | "unreadable";

export interface ChangedFile {
  path: string;
  before: string | null;
  after: string | null;
  note?: ChangedFileNote;
  truncated: boolean;
}

export interface SessionState {
  model?: string;
  thinking: boolean;
  effort?: EffortLevel;
  title: string;
  leafId: string | null;
  undoable: boolean;
  redoable: boolean;
}

export type PromptOutcome = "started" | "queued" | "missing";

export type InjectOutcome = "started" | "queued" | "missing";

export type AbortOutcome = "aborted" | "idle" | "missing";

export type ForkOutcome = SessionSummary | "missing" | "unknown-entry";

export type LabelOutcome = "labelled" | "missing" | "unknown-entry";

export type LeafOutcome = { leafId: string | null } | "missing" | "unknown-entry" | "busy";

export type ChangesOutcome<Reading> = Reading | "missing" | "untrusted" | "no-baseline";

export type BindOutcome = "bound" | "missing";

export type SwitchBotOutcome = "switched" | "busy" | "missing";

export class HostRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HostRefusal";
  }
}

export type BoundModel =
  | { ok: true; provider: Provider; reference: string }
  | { ok: false; failure: ResolutionFailure };

export interface SessionInference {
  bind(selection: string | undefined): BoundModel;
}

export type ModelOutcome =
  | "missing"
  | "busy"
  | { ok: true; model: ModelReference; notice: string }
  | { ok: false; failure: ResolutionFailure };

export type ThinkingOutcome = "missing" | { thinking: boolean };

export type EffortOutcome = "missing" | { effort: EffortLevel | null };

export interface Compacted {
  compacted: CompactionEntry | null;
  notices: readonly string[];
}

export type CompactOutcome = "missing" | "busy" | Compacted;

export interface UndonePrompt {
  entryId: string;
  text: string;
}

export interface Undone {
  prompt: UndonePrompt | null;
  filesNote: string;
  undoable: boolean;
  redoable: boolean;
}

export type UndoOutcome = "missing" | "busy" | "staged" | "nothing" | Undone;

export interface Redone {
  restored: true;
  undoable: boolean;
  redoable: boolean;
}

export type RedoOutcome = "missing" | "busy" | "nothing" | Redone;

export interface ContextReport extends ContextReading {
  fullness: number;
  flushDue: boolean;
  compactionDue: boolean;
  basis: "estimated";
}

export interface ModelCost {
  reference: string;
  turns: number;
  usage: Usage;
  rollup: CostRollup;
}

export interface CostReport {
  rollup: CostRollup;
  usage: Usage;
  basis: string;
  cacheMiss?: CacheMiss;
  models: readonly ModelCost[];
}

export type ExportScope = "path" | "tree";

export interface ExportRequest {
  scope: ExportScope;
  out?: string | undefined;
}

export type ExportOutcome = "missing" | { html: string } | { file: string } | { refused: string };

export type RenameOutcome = "missing" | { title: string };

export type PresetOutcome =
  | "unavailable"
  | "needs-confirmation"
  | { from: ActivePreset; to: PresetName };

export type CheckpointsOutcome = "missing" | "off" | CheckpointReads;

export interface SessionHost extends WorkspaceHost, SurfaceHost {
  list(): Promise<readonly SessionSummary[]>;
  read(id: string): Promise<SessionDetail | undefined>;
  create(): Promise<SessionSummary>;
  prompt(id: string, text: string, behavior: SendBehavior): Promise<PromptOutcome>;
  inject(id: string, text: string, origin: PromptOrigin): Promise<InjectOutcome>;
  abort(id: string): Promise<AbortOutcome>;
  entries(id: string): Promise<SessionEntries | undefined>;
  fork(id: string, entryId: string): Promise<ForkOutcome>;
  label(id: string, entryId: string, label: string | undefined): Promise<LabelOutcome>;
  moveLeaf(id: string, entryId: string | null): Promise<LeafOutcome>;
  changes(id: string): Promise<ChangesOutcome<SessionChanges>>;
  changedFile(id: string, path: string): Promise<ChangesOutcome<ChangedFile>>;
  spill(id: string, spillId: string, range: FileRange): Promise<SpillOutcome>;
  setModel(id: string, reference: string): Promise<ModelOutcome>;
  setThinking(id: string, on: boolean): Promise<ThinkingOutcome>;
  setEffort(id: string, level: EffortLevel | null): Promise<EffortOutcome>;
  compact(id: string, focus: string | undefined): Promise<CompactOutcome>;
  undo(id: string): Promise<UndoOutcome>;
  redo(id: string): Promise<RedoOutcome>;
  context(id: string): Promise<ContextReport | "missing">;
  cost(id: string): Promise<CostReport | "missing">;
  export(id: string, request: ExportRequest): Promise<ExportOutcome>;
  rename(id: string, title: string): Promise<RenameOutcome>;
  checkpointsOf(id: string): Promise<CheckpointsOutcome>;
  setPreset(name: PresetName, confirmed: boolean): Promise<PresetOutcome>;
  asks(): Promise<readonly PendingAsk[]>;
  answerAsk(callId: string, verdict: AskVerdict, scope?: AskScope): Promise<AnswerOutcome>;
  permissions(): Promise<PermissionsView>;
  revokeWorkspaceGrant(rule: PermissionRule): Promise<boolean>;
  memory: MemoryHost;
  close(): Promise<void>;
}

export interface WorkspaceHost {
  workspace(): Promise<WorkspaceView>;
  tree(path: string): Promise<TreeListing>;
  readFile(path: string, range: FileRange): Promise<FileSlice>;
  trustWorkspace(): Promise<TrustGrant>;
  themes(): Promise<ThemesView>;
}

export interface SurfaceHost {
  mcpServers(): Promise<readonly McpServerStatus[]>;
  restartMcpServer(name: string): Promise<McpServerStatus>;
  setMcpServerEnabled(name: string, enabled: boolean): Promise<McpServerStatus>;
  mcpServerTools(name: string): Promise<readonly string[]>;
  arcs(): Promise<ArcsView>;
  createArc(slug: string | undefined): Promise<ArcSummary>;
  closeArc(slug: string, direction: string | undefined): Promise<ArcCloseOutcome>;
  abandonArc(slug: string): Promise<void>;
  bindArc(sessionId: string, slug: string | null): Promise<BindOutcome>;
  bots(): Promise<readonly BotSummary[]>;
  createBot(draft: BotDraft): Promise<BotEntry>;
  switchBot(sessionId: string, name: string | null): Promise<SwitchBotOutcome>;
  workspaces(): Promise<readonly WorkspaceChoice[]>;
  createWorkspace(slug: string): Promise<void>;
  useWorkspace(slug: string | null): Promise<void>;
  focusWorkspace(slug: string | null, dir: string): Promise<string>;
  unfocusWorkspace(slug: string | null, dir: string): Promise<void>;
}

export interface WorkspaceView {
  anchor: { root: string; source: "declaration" | "git" | "launch" };
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
  readiness: "ready" | "undeclared" | "undecided" | "refused";
}

export interface TreeEntry {
  name: string;
  kind: "file" | "dir";
  ignored: boolean;
  hidden: boolean;
}

export interface TreeListing {
  path: string;
  entries: readonly TreeEntry[];
}

export interface FileRange {
  from?: number;
  to?: number;
}

export interface FileSlice {
  path: string;
  bytes: number;
  from: number;
  to: number;
  text: string;
  truncated: boolean;
  eof: boolean;
  encoding: "utf-8";
}

export interface SpillSlice extends Omit<FileSlice, "path"> {
  spillId: string;
}

export type SpillOutcome = SpillSlice | "missing";

export const maxFileSliceBytes = 1024 * 1024;

export const maxFileBytes = 20 * 1024 * 1024;

export interface TrustGrant {
  trusted: true;
  root: string;
  reopens: boolean;
}

export interface ThemesView {
  themes: readonly CompleteTheme[];
  active: string;
  placeholders: readonly string[];
}

export interface ArcSummary {
  slug: string;
  status: ArcStatus;
  created: string;
  sessions: number;
}

export interface ArcsView {
  arcs: readonly ArcSummary[];
  ordinals: Readonly<Record<string, number>>;
}

export type ArcCloseOutcome =
  | { kind: "closed"; delivered: number; released: number; notice?: string }
  | { kind: "pending"; candidates: number; questions: number; wedged: number; notice?: string };

export type BotScope = "project" | "user";

export interface BotEntry {
  name: string;
  sigil: string;
  source: BotScope;
  description?: string;
  model?: string;
  learning?: string;
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

export function sliceBounds(
  bytes: number,
  range: FileRange,
): Omit<FileSlice, "path" | "text" | "encoding"> {
  const from = Math.min(Math.max(range.from ?? 0, 0), bytes);
  const requestedTo = Math.min(Math.max(range.to ?? bytes, from), bytes);
  const to = Math.min(requestedTo, from + maxFileSliceBytes);
  return { bytes, from, to, truncated: to < requestedTo, eof: to >= bytes };
}

export interface MemoryHost {
  trusted(): Promise<boolean>;
  garden(): Promise<MemoryGarden>;
  inbox(): Promise<InboxItem[]>;
  approve(id: string): Promise<WriteResult | undefined>;
  discard(id: string): Promise<void>;
  notes(layer?: string): Promise<MemoryNote[] | undefined>;
  note(name: string, layer?: string): Promise<MemoryNote | undefined>;
  dailyDates(): Promise<string[]>;
  daily(date: string): Promise<DailyEntry[]>;
  ledger(): Promise<readonly LedgerEntry[]>;
  revert(ledgerId: string): Promise<RevertOutcome>;
  ask(query: string, arc?: string): Promise<MemoryQueryOutcome>;
  airlock: MemoryAirlock;
  recount(): Promise<void>;
}

export type MemoryLayerKind = "workspace" | "arc";

export interface MemoryLayer {
  id: string;
  kind: MemoryLayerKind;
  label: string;
  arc?: string;
  notes: number;
  curing: Record<CuringStage, number>;
  prompt?: { budget: number; used: number };
}

export interface NoteRelation {
  name: string;
  predicate: string;
  direction: "out" | "in";
}

export interface MemoryNote extends Note {
  layer: string;
  curing: CuringStage;
  injected: boolean;
  recalls: number;
  relations: NoteRelation[];
}

export type InboxItem = StagedItem & { bot?: string };

export interface GardenerActivity {
  state: "idle" | "working" | "failed";
  sweptAt?: string;
}

export interface MemoryGarden {
  trusted: boolean;
  layers: MemoryLayer[];
  inbox: InboxItem[];
  ledger: readonly LedgerEntry[];
  audit: AuditEntry[];
  gardener: GardenerActivity;
  airlocks: AirlockDigest[];
}

export type QueryLeg = "lexical" | "semantic" | "graph";

export interface MemoryQueryHit {
  note: string;
  layer: string;
  ranks: Partial<Record<QueryLeg, number>>;
  boost?: number;
  superseded: boolean;
}

export interface MemoryQueryOutcome {
  hits: MemoryQueryHit[];
  source: "lexical" | "hybrid" | "lexical-degraded";
  embeddings?: string;
}

export type CandidateChoice = "deliver" | "leave";

export type QuestionChoice = "resolve" | "carry" | "drop";

export interface AirlockCandidate {
  note: string;
  title: string;
  provenance: Provenance;
  eligible: boolean;
  shortfalls: string[];
  created?: string;
  choice?: CandidateChoice;
}

export interface AirlockQuestion {
  title: string;
  provenance: Provenance;
  created?: string;
  choice?: QuestionChoice;
}

export interface AirlockDigest {
  arc: string;
  candidates: AirlockCandidate[];
  questions: AirlockQuestion[];
  successor?: string;
  sweep?: { acked: number; wedged: number };
  direction?: string;
}

export type AirlockFinishOutcome =
  | { kind: "closed"; delivered: number; released: number; notice?: string }
  | { kind: "pending"; candidates: number; questions: number; wedged: number; notice?: string }
  | { kind: "undecided"; items: string[] }
  | { kind: "wedged"; sessions: string[] };

export interface MemoryAirlock {
  digest(slug: string): Promise<AirlockDigest | undefined>;
  triageCandidate(slug: string, note: string, choice: CandidateChoice): Promise<void>;
  triageQuestion(slug: string, title: string, choice: QuestionChoice): Promise<void>;
  deliverEligible(slug: string): Promise<number>;
  finish(slug: string, options?: { force?: boolean }): Promise<AirlockFinishOutcome>;
}
