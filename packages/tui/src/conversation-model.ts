import {
  type Agent,
  type AgentContext,
  type AskRule,
  type Confirmation,
  clipToolOutput,
  type EffortLevel,
  EventBus,
  effortLevels,
  type ImagePart,
  isEffortLevel,
  type Message,
  type PermissionDecision,
  type QueuedPrompt,
  QueuedPromptCancelledError,
  type SendBehavior,
  type SpillReference,
  type TickScheduler,
  type ToolCallPart,
  type TurnSettlement,
} from "@keywork/engine";
import { type PermissionRule, toError } from "@keywork/shared";
import { type AwayStretch, AwayWatch, awayDigest } from "./away-summary.ts";
import { type BotEntry, type BotSummary, describeBotSpend, learningPolicyReadout } from "./bots.ts";
import { CompactionOffer, compactionOfferNotice } from "./compaction-offer.ts";
import { contextReadout } from "./context-map.ts";
import type { FileReader } from "./diff-render.ts";
import { type ForgetHook, type ForgetOutcome, forgetPickerHint, forgetPickOf } from "./forget.ts";
import type { Chord } from "./keys.ts";
import { defaultPageMarks, type PageMarks } from "./marks.ts";
import { attachMentionedFiles, promptAsTyped } from "./mention-attachments.ts";
import type { MentionSource } from "./mention-completer.ts";
import { type AskDiffWindow, MutationAsk, type PendingAsk } from "./mutation-ask.ts";
import { columnPage, type PageGrammar } from "./page.ts";
import type { FileOpenOptions } from "./pane.ts";
import { QuietRunLog, type SessionGrantsPort } from "./permissions-model.ts";
import {
  type CommandSuggestion,
  type CommandsPort,
  type EditorOutcome,
  PromptEditor,
  type SendMode,
} from "./prompt-editor.ts";
import type { PromptUndoHook, ReopenedUndo, StagedUndo } from "./prompt-undo.ts";
import type { ReplayedSummary } from "./session-attachment.ts";
import { SessionLedger } from "./session-ledger.ts";
import {
  type ShellEscapePort,
  shellEscapeCall,
  shellEscapeCommand,
  shellEscapeTranscript,
} from "./shell-escape.ts";
import { answerAside } from "./side-question.ts";
import {
  type ChildMark,
  type LedgerEntry,
  type ToolRun,
  type TranscriptEntry,
  TranscriptFeed,
  type UserEntry,
} from "./transcript-feed.ts";
import { TranscriptNavigation } from "./transcript-navigation.ts";
import { type TranscriptLine, TranscriptView } from "./transcript-view.ts";
import {
  forkedNotice,
  ledgerFacts,
  modelTurns,
  restoredNotice,
  restoreKeptNotice,
  restoreQuestion,
  restoreReach,
  type TurnLedgerReader,
  type TurnRecord,
} from "./turn-ledger.ts";

export type { CommandSuggestion, CommandsPort } from "./prompt-editor.ts";

export type Titler = (
  conversation: readonly Message[],
  agent: Agent,
) => Promise<string | undefined>;

export type ForkOutcome = { forked: false } | { forked: true; note?: string };

export interface ConversationPorts {
  readFile?: FileReader;
  forkAtPrompt?: (promptId: string, draft: string) => Promise<ForkOutcome>;
  forkAfterPrompt?: (promptId: string) => Promise<ForkOutcome>;
  idleNotice?: string;
  now?: () => number;
  botSpend?: (bot: string) => Promise<BotSummary | undefined>;
  botOf?: (bot: string) => BotEntry | undefined;
  shellEscape?: ShellEscapePort;
  recordShellEscape?: (transcript: string) => Promise<string | undefined>;
  frameTick?: TickScheduler;
  spillFile?: (spillId: string) => string | undefined;
  openFile?: (path: string, options: FileOpenOptions) => void;
  openSession?: (sessionId: string) => void;
  workspaceFiles?: MentionSource;
}

export type QueueMove = -1 | 1;

export interface QueuedSend {
  readonly text: string;
  readonly behavior: SendBehavior;
}

export type CompactionHook = (instructions: string) => Promise<void>;

export type ToolBatchHook = () => Promise<TurnSettlement | undefined>;

export type ThinkingChangeHook = (level: "on" | "off") => Promise<void>;

export type EffortChangeHook = (level: EffortLevel) => Promise<void>;

export type RenameHook = (title: string) => Promise<void>;

export type QuietChangeHook = (on: boolean) => Promise<void>;

export type SessionRulesHook = (rules: readonly PermissionRule[]) => Promise<void>;

export type SettledOutcome = "finished" | "failed";

export interface KeyViewport {
  transcriptRows: number;
  askRows: number;
}

export const defaultIdleNotice = "no model bound · /connect adds a provider · /model picks one";

export const defaultKeyViewport: KeyViewport = { transcriptRows: 10, askRows: 8 };

export class ConversationModel {
  readonly feed: TranscriptFeed;
  readonly editor: PromptEditor;
  readonly ledger = new SessionLedger();
  readonly quietRuns = new QuietRunLog();
  title: string | undefined;
  lastSend: Promise<unknown> = Promise.resolve();
  lastTitle: Promise<unknown> = Promise.resolve();
  lastFork: Promise<unknown> = Promise.resolve();
  lastUndo: Promise<unknown> = Promise.resolve();
  lastForget: Promise<unknown> = Promise.resolve();
  lastAside: Promise<unknown> = Promise.resolve();
  lastLedgerRead: Promise<unknown> = Promise.resolve();
  private readonly ask: MutationAsk;
  private readonly away = new AwayWatch();
  private readonly navigation: TranscriptNavigation;
  private readonly view = new TranscriptView();
  private agent: Agent | undefined;
  private unfollow: () => void = () => {};
  private afterTurn: (() => Promise<void>) | undefined;
  private turnOpened: (() => void) | undefined;
  private compaction: CompactionHook | undefined;
  private toolBatchSettle: ToolBatchHook | undefined;
  private forget: ForgetHook | undefined;
  private forgetReplacement: string | null = null;
  private thinkingChange: ThinkingChangeHook | undefined;
  private effortChange: EffortChangeHook | undefined;
  private promptUndo: PromptUndoHook | undefined;
  private stagedUndo: StagedPromptUndo | undefined;
  private settledListener: ((outcome: SettledOutcome) => void) | undefined;
  private renaming: RenameHook | undefined;
  private quietChange: QuietChangeHook | undefined;
  private servedContextRead: (() => Promise<AgentContext | undefined>) | undefined;
  private servedContext: AgentContext | undefined;
  private turnLedger: TurnLedgerReader | undefined;
  private ledgerRecords: readonly TurnRecord[] = [];
  private ledgerStale = false;
  private ledgerReading = false;
  private pendingRestore: PendingRestore | undefined;
  private titleRequested = false;
  private retrievalDisclosed = false;
  private disposed = false;
  private shellSequence = 0;
  private shellAbort: AbortController | undefined;
  private queueCursor: number | undefined;
  private readonly compactionOffer = new CompactionOffer();

  constructor(
    agent: Agent | undefined,
    private readonly notify: () => void,
    private readonly titler?: Titler,
    private readonly commands?: CommandsPort,
    private readonly ports?: ConversationPorts,
  ) {
    const touch = () => this.touch();
    this.feed = new TranscriptFeed(touch, ports?.now, ports?.frameTick);
    this.editor = new PromptEditor(touch, conversationCommands, commands, ports?.workspaceFiles);
    this.ask = new MutationAsk(touch, ports?.readFile, ports?.now);
    this.navigation = new TranscriptNavigation(this.feed, touch);
    if (agent === undefined) {
      this.feed.entries.push({ kind: "info", text: ports?.idleNotice ?? defaultIdleNotice });
      return;
    }
    this.follow(agent);
  }

  get entries(): readonly TranscriptEntry[] {
    return this.feed.entries;
  }

  get input(): string {
    return this.editor.value;
  }

  get busy(): boolean {
    if (this.disposed) return false;
    return this.shellAbort !== undefined || (this.agent?.busy() ?? false);
  }

  get activity(): number {
    return this.feed.activity;
  }

  get pendingAsk(): PendingAsk | undefined {
    return this.ask.pending;
  }

  askHoldsKeys(): boolean {
    return this.ask.armed();
  }

  askSeen(): void {
    this.ask.seen();
  }

  askRegainedFocus(): void {
    this.ask.holdArming();
  }

  get scrollBack(): number {
    return this.navigation.scrollBack;
  }

  get selectedSuggestion(): number {
    return this.editor.selectedSuggestion;
  }

  currentAgent(): Agent | undefined {
    return this.agent;
  }

  queued(): readonly string[] {
    return this.queuedSends().map((send) => send.text);
  }

  queuedSends(): readonly QueuedSend[] {
    return this.queuedPrompts().map((prompt) => ({
      text: promptAsTyped(prompt.text),
      behavior: prompt.behavior,
    }));
  }

  queuedPrompts(): readonly QueuedPrompt[] {
    return this.agent?.queued() ?? [];
  }

  queueSelection(): number | undefined {
    const cursor = this.queueCursor;
    const count = this.queuedPrompts().length;
    if (cursor === undefined || count === 0) return undefined;
    return Math.min(cursor, count - 1);
  }

  editingQueue(): boolean {
    return this.queueSelection() !== undefined;
  }

  suggestions(): readonly CommandSuggestion[] {
    return this.editor.suggestions();
  }

  traySelect(at: number): void {
    this.editor.selectSuggestion(at);
  }

  trayAccept(at: number): boolean {
    const outcome = this.editor.acceptSuggestion(at);
    if (outcome === "pass") return false;
    return this.applyEdit(outcome);
  }

  usageSummary(): string {
    return this.ledger.usageSummary(this.agent);
  }

  spendSummary(): string {
    return this.agent === undefined ? "" : this.ledger.spendSummary(this.agent);
  }

  contextReading(): AgentContext | undefined {
    return this.contextMap();
  }

  contextMap(): AgentContext | undefined {
    return this.servedContext ?? this.ledger.contextMap(this.agent);
  }

  bindServedContext(read: () => Promise<AgentContext | undefined>): void {
    this.servedContextRead = read;
    this.readServedContext();
  }

  expectSummaries(summaries: readonly ReplayedSummary[]): void {
    this.feed.expectSummaries(summaries);
  }

  compact(focus = ""): void {
    this.compactNow(focus);
  }

  activeTool(): ToolRun | undefined {
    return this.feed.activeTool();
  }

  noteShellDecision(call: ToolCallPart, decision: PermissionDecision): void {
    this.quietRuns.noteShellEscape(call, decision);
    this.feed.ruleOn(decision);
  }

  turnRecords(): readonly TurnRecord[] {
    return this.ledgerRecords;
  }

  toolWords(callId: string): string | undefined {
    const run = this.entries.find((entry) => entry.kind === "tool" && entry.run?.callId === callId);
    if (run?.kind !== "tool" || run.run === undefined) return undefined;
    return run.run.subject === "" ? run.run.name : `${run.run.name} ${run.run.subject}`;
  }

  turnElapsedMs(): number | undefined {
    return this.feed.turnElapsedMs();
  }

  backtracking(): boolean {
    return this.navigation.backtracking();
  }

  disclosing(): boolean {
    return this.navigation.disclosing();
  }

  cursoredSpill(): SpillReference | undefined {
    return this.cursoredRun()?.spill;
  }

  cursoredChild(): ChildMark | undefined {
    return this.cursoredRun()?.child;
  }

  cursoredLedger(): LedgerEntry | undefined {
    const at = this.navigation.viewport().foldCursor;
    const entry = at === undefined ? undefined : this.entries[at];
    return entry?.kind === "ledger" && entry.record !== undefined ? entry : undefined;
  }

  restoreAsk(): string | undefined {
    return this.pendingRestore?.question;
  }

  visibleTranscript(
    width: number,
    rows: number,
    page: PageGrammar = columnPage,
    marks: PageMarks = defaultPageMarks,
  ): TranscriptLine[] {
    this.foldAttachments();
    const frame = this.view.frame(
      this.feed,
      { width, rows, page, marks },
      this.navigation.viewport(),
    );
    this.navigation.framed(frame.scrollBack, frame.total);
    return frame.lines;
  }

  handleKey(chord: Chord, sequence: string | undefined, viewport = defaultKeyViewport): boolean {
    if (this.ask.pending !== undefined) return this.handleAskKey(chord, sequence, viewport.askRows);
    if (this.pendingRestore !== undefined) return this.answerRestore(chord);
    if (this.navigation.backtracking()) return this.handleBacktrackKey(chord, sequence, viewport);
    if (this.editingQueue()) return this.handleQueueKey(chord, sequence, viewport);
    if (isOpenKey(chord) && this.cursoredSpill() !== undefined) return this.openCursoredSpill();
    if (isOpenKey(chord) && this.cursoredChild() !== undefined) return this.openCursoredChild();
    const ledger = this.cursoredLedger();
    if (ledger !== undefined && this.handleLedgerKey(ledger, chord)) return true;
    if (this.navigation.disclosing() && chord.name !== "tab") {
      this.navigation.exitDisclosure();
      if (chord.name === "escape") return true;
    }
    const primed = this.navigation.takeEscapePrime();
    if (chord.name === "tab" && !this.editor.completing()) {
      if (!this.editor.isEmpty()) return this.editor.expandPlaceholderAtCursor();
      return chord.shift ? this.navigation.stepFoldCursor() : this.navigation.toggleCursoredFold();
    }
    const queueEntry = queueEntryDirection(chord);
    if (queueEntry !== undefined && this.editor.isEmpty())
      return this.enterQueueEditing(queueEntry);
    const edited = this.editor.handleKey(chord, sequence);
    if (edited !== "pass") return this.applyEdit(edited);
    switch (chord.name) {
      case "escape":
        return this.handleEscape(primed);
      case "pageup":
        return this.navigation.scrollBy(viewport.transcriptRows);
      case "pagedown":
        return this.navigation.scrollBy(-viewport.transcriptRows);
      default:
        return false;
    }
  }

  paste(text: string): boolean {
    if (this.ask.takesPaste(text)) return true;
    this.ask.holdArming();
    this.editor.paste(text);
    return true;
  }

  scrollBy(delta: number): boolean {
    return this.navigation.scrollBy(delta);
  }

  submitText(text: string, mode: SendMode = "queue", images: readonly ImagePart[] = []): void {
    const trimmed = text.trim();
    if (trimmed === "" || this.disposed) return;
    this.stagedUndo = undefined;
    const behavior = mode === "now" ? this.setQueueAside() : mode;
    const command = shellEscapeCommand(trimmed);
    if (command !== undefined) {
      this.submitShell(trimmed, command, behavior);
      return;
    }
    if (this.agent === undefined) return;
    this.editor.remember(trimmed);
    this.navigation.snapToLive();
    this.send(this.withMentionedFiles(trimmed), behavior, images);
  }

  confirmMutation(call: ToolCallPart): Promise<boolean> {
    return this.ask.confirm(call);
  }

  mutationConfirmation(call: ToolCallPart): Promise<Confirmation> {
    return this.ask.confirmation(call);
  }

  grantsQuietly(call: ToolCallPart, rule: AskRule): boolean {
    return this.ask.grantQuietly(call, rule);
  }

  waitingAsks(): { asks: number; tools: string[] } {
    return this.ask.waiting();
  }

  quiet(): boolean {
    return this.ask.quiet;
  }

  adoptQuiet(on: boolean): void {
    this.ask.quiet = on;
    this.touch();
  }

  bindQuietChange(hook: QuietChangeHook): void {
    this.quietChange = hook;
  }

  toggleQuiet(): void {
    const on = !this.ask.quiet;
    this.ask.quiet = on;
    this.feed.post("info", on ? quietOnNotice : quietOffNotice);
    this.lastSend = (this.quietChange?.(on) ?? Promise.resolve()).catch((cause: unknown) =>
      this.reportUndoFailure(cause),
    );
  }

  sessionGrants(): SessionGrantsPort {
    return {
      rules: async () => this.ask.sessionRules,
      forget: async (rule) => this.ask.forgetSessionRule(rule),
    };
  }

  adoptSessionRules(rules: readonly PermissionRule[]): void {
    this.ask.adoptSessionRules(rules);
  }

  bindSessionRulesJournal(record: SessionRulesHook): void {
    this.ask.onSessionRulesChanged((rules) => {
      void record(rules).catch((cause: unknown) => this.reportUndoFailure(cause));
    });
  }

  askDiffWindow(rows: number): AskDiffWindow {
    return this.ask.diffWindow(rows);
  }

  toggleToolFold(entry: TranscriptEntry): boolean {
    return this.feed.toggleFold(entry);
  }

  toggleLatestToolFold(): boolean {
    return this.feed.toggleLatestFold();
  }

  adoptTitle(title: string): void {
    this.title = title;
    this.titleRequested = true;
    this.touch();
  }

  adoptPromptId(entryId: string): void {
    this.feed.adoptPromptId(entryId);
  }

  bindAfterTurn(hook: () => Promise<void>): void {
    this.afterTurn = hook;
  }

  bindTurnOpened(hook: () => void): void {
    this.turnOpened = hook;
  }

  bindCompaction(hook: CompactionHook): void {
    this.compaction = hook;
  }

  bindToolBatchSettler(hook: ToolBatchHook): void {
    this.toolBatchSettle = hook;
  }

  bindForget(hook: ForgetHook): void {
    this.forget = hook;
  }

  beginForget(replacement: string | undefined): void {
    if (this.forget === undefined) {
      this.feed.post("info", "can't forget · no session store");
      return;
    }
    if (this.busy) {
      this.feed.post("info", turnRunningNotice);
      return;
    }
    this.forgetReplacement = replacement ?? null;
    if (!this.navigation.enterPicker("forget")) this.feed.post("info", nothingToForgetNotice);
  }

  pickerHint(): string {
    return this.navigation.pickerPurpose() === "forget" ? forgetPickerHint : forkPickerHint;
  }

  bindThinkingChange(hook: ThinkingChangeHook): void {
    this.thinkingChange = hook;
  }

  bindEffortChange(hook: EffortChangeHook): void {
    this.effortChange = hook;
  }

  bindPromptUndo(hook: PromptUndoHook): void {
    this.promptUndo = hook;
  }

  undoStaged(): boolean {
    return this.stagedUndo !== undefined;
  }

  adoptStagedUndo(reopened: ReopenedUndo): void {
    const entries = this.retoldTurns(reopened);
    const prompt = entries[0];
    if (prompt?.kind !== "user") return;
    this.stagedUndo = { undo: reopened.undo, at: "end", entries };
    if (this.editor.isEmpty()) this.editor.load(promptAsTyped(prompt.text));
    this.feed.post("info", reopenedUndoNotice(reopened.undo.filesNote));
  }

  undoLastPrompt(): boolean {
    const at = this.feed.promptIndices().at(-1);
    const prompt = at === undefined ? undefined : this.feed.entries[at];
    if (this.promptUndo === undefined || prompt?.kind !== "user") return false;
    if (prompt.entryId === undefined) return false;
    return this.rewindFrom(prompt, undoneNotice);
  }

  restoreTurn(turn: number): void {
    const record = this.ledgerRecords.find((candidate) => candidate.turn === turn);
    const prompt = record === undefined ? undefined : this.promptOf(record);
    if (this.promptUndo === undefined) this.feed.post("info", noRestoreNotice);
    else if (record === undefined)
      this.feed.post("info", unknownTurnNotice(turn, this.ledgerRecords));
    else if (prompt === undefined) this.feed.post("info", foldedTurnNotice(turn));
    else this.rewindFrom(prompt, (filesNote) => this.restoredNotice(turn, filesNote));
  }

  bindRename(hook: RenameHook): void {
    this.renaming = hook;
  }

  rename(title: string): void {
    const trimmed = title.trim();
    const hook = this.renaming;
    if (trimmed === "") {
      this.feed.post("info", renameUsage);
      return;
    }
    if (hook === undefined) {
      this.feed.post("info", "can't rename · no session store");
      return;
    }
    this.adoptTitle(trimmed);
    this.lastTitle = hook(trimmed).then(
      () => this.postNotice(`renamed ${trimmed} · the titler leaves it alone now`),
      (cause: unknown) => this.reportUndoFailure(cause),
    );
  }

  bindTurnLedger(read: TurnLedgerReader): void {
    this.turnLedger = read;
    this.feed.onLedgerRow = () => this.refreshLedger();
    this.refreshLedger();
  }

  refreshLedger(): void {
    const read = this.turnLedger;
    if (read === undefined || this.disposed) return;
    if (this.ledgerReading) {
      this.ledgerStale = true;
      return;
    }
    this.ledgerReading = true;
    this.lastLedgerRead = this.readLedger(read).finally(() => {
      this.ledgerReading = false;
      if (!this.ledgerStale) return;
      this.ledgerStale = false;
      this.refreshLedger();
    });
  }

  redoPrompt(): boolean {
    const staged = this.stagedUndo;
    if (staged === undefined) return false;
    this.stagedUndo = undefined;
    this.lastUndo = staged.undo.cancel().then(
      () => this.unstage(staged),
      (cause: unknown) => {
        this.stagedUndo = staged;
        this.reportUndoFailure(cause);
      },
    );
    return true;
  }

  onSettled(listener: (outcome: SettledOutcome) => void): void {
    this.settledListener = listener;
  }

  swapAgent(agent: Agent): void {
    const previous = this.agent;
    if (previous === agent) return;
    if (previous !== undefined) this.ledger.retire(previous);
    if (previous !== undefined) agent.setThinking(previous.thinking());
    const effort = previous?.effort();
    if (effort !== undefined) agent.setEffort(effort);
    this.ask.denyAll();
    this.follow(agent);
    if (previous !== undefined) agent.adoptQueue(previous);
  }

  discloseRetrieval(text: string): void {
    if (this.disposed || this.retrievalDisclosed) return;
    this.retrievalDisclosed = true;
    this.feed.post("info", text);
  }

  postNotice(text: string): void {
    if (!this.disposed) this.feed.post("info", text);
  }

  reportSettlement(settlement: Pick<TurnSettlement, "notices" | "compacted">): void {
    if (this.disposed) return;
    const compacted = settlement.compacted;
    if (compacted !== undefined) this.feed.postSummary("compaction", compacted.summary);
    for (const notice of settlement.notices) this.feed.post("info", notice);
  }

  postAside(text: string): void {
    if (this.disposed) return;
    this.feed.entries.push({ kind: "assistant", text, progress: true });
    this.touch();
  }

  attend(paneFocused: boolean): void {
    this.welcomeBack(this.away.attend({ pane: paneFocused }, this.entries.length));
  }

  terminalFocusChanged(focused: boolean): void {
    this.welcomeBack(this.away.attend({ terminal: focused }, this.entries.length));
  }

  dispose(): void {
    this.disposed = true;
    this.shellAbort?.abort();
    this.unfollow();
    this.ask.close();
    this.feed.endStream();
    this.navigation.reset();
    const agent = this.agent;
    if (agent === undefined) return;
    for (const { id } of agent.queued()) agent.cancelQueued(id);
    agent.interrupt();
  }

  private touch(): void {
    if (!this.disposed) this.notify();
  }

  private readServedContext(): void {
    const read = this.servedContextRead;
    if (read === undefined) return;
    void read()
      .then((reading) => {
        if (reading === undefined || this.disposed) return;
        this.servedContext = reading;
        this.touch();
      })
      .catch(() => {});
  }

  private async readLedger(read: TurnLedgerReader): Promise<void> {
    const stored = await read().catch(() => this.ledgerRecords);
    if (this.disposed) return;
    const records = modelTurns(stored, this.feed.shellTranscriptIds());
    this.ledgerRecords = records;
    const byPrompt = new Map(records.map((record) => [record.promptId, record]));
    for (const row of this.feed.ledgerRows()) {
      const promptId = row.prompt.entryId;
      const record = promptId === undefined ? undefined : byPrompt.get(promptId);
      if (record === undefined) continue;
      row.record = record;
      row.text = ledgerFacts(record);
    }
    this.touch();
  }

  private handleLedgerKey(row: LedgerEntry, chord: Chord): boolean {
    if (chord.ctrl || chord.meta || chord.shift) return false;
    switch (chord.name) {
      case "u":
        return this.askRestore(row);
      case "f":
        return this.forkAfter(row);
      case "enter":
      case "return":
        this.feed.toggleFold(row);
        return true;
      default:
        return false;
    }
  }

  private askRestore(row: LedgerEntry): true {
    const record = row.record;
    if (record === undefined) return true;
    if (this.promptUndo === undefined) this.feed.post("info", noRestoreNotice);
    else if (this.stagedUndo !== undefined) this.feed.post("info", alreadyStagedNotice);
    else if (this.busy) this.feed.post("info", turnRunningNotice);
    else {
      const reach = restoreReach(this.ledgerRecords, record.turn);
      const question = restoreQuestion(record.turn, promptAsTyped(row.prompt.text), reach);
      this.pendingRestore = { row, question };
      this.touch();
    }
    return true;
  }

  private answerRestore(chord: Chord): true {
    const pending = this.pendingRestore;
    this.pendingRestore = undefined;
    const record = pending?.row.record;
    if (pending === undefined || record === undefined) return true;
    if (chord.name !== "y" || chord.ctrl || chord.meta) {
      this.feed.post("info", restoreKeptNotice);
      return true;
    }
    this.navigation.exitDisclosure();
    this.rewindFrom(pending.row.prompt, (filesNote) => this.restoredNotice(record.turn, filesNote));
    return true;
  }

  private restoredNotice(turn: number, filesNote: string): string {
    const undone = this.ledgerRecords.filter((record) => record.turn >= turn).length;
    return restoredNotice(turn, Math.max(1, undone), filesNote);
  }

  private forkAfter(row: LedgerEntry): true {
    const record = row.record;
    const fork = this.ports?.forkAfterPrompt;
    if (record === undefined) return true;
    if (this.busy) this.feed.post("info", turnRunningNotice);
    else if (fork === undefined) this.feed.post("info", "can't fork · no session store");
    else {
      this.navigation.exitDisclosure();
      this.lastFork = fork(record.promptId).then(
        (outcome) =>
          this.postNotice(outcome.forked ? forkedNotice(record.turn) : noForkPointNotice),
        (cause: unknown) => this.reportUndoFailure(cause),
      );
    }
    return true;
  }

  private promptOf(record: TurnRecord): UserEntry | undefined {
    return this.feed.entries.find(
      (entry): entry is UserEntry => entry.kind === "user" && entry.entryId === record.promptId,
    );
  }

  private rewindFrom(prompt: UserEntry, notice: (filesNote: string) => string): boolean {
    const hook = this.promptUndo;
    const at = this.feed.entries.indexOf(prompt);
    const entryId = prompt.entryId;
    if (hook === undefined || at === -1 || entryId === undefined) return false;
    if (this.stagedUndo !== undefined) this.feed.post("info", alreadyStagedNotice);
    else if (this.busy) this.feed.post("info", turnRunningNotice);
    else
      this.lastUndo = hook(entryId).then(
        (staged) => this.stageUndo(staged, at, promptAsTyped(prompt.text), notice),
        (cause: unknown) => this.reportUndoFailure(cause),
      );
    return true;
  }

  private follow(agent: Agent): void {
    this.unfollow();
    this.agent?.settleTurnsWith(undefined);
    this.agent?.settleToolBatchesWith(undefined);
    agent.settleTurnsWith(() => this.settleAfterTurn());
    agent.settleToolBatchesWith(() => this.settleToolBatch());
    const stops = [
      this.feed.follow(agent.bus),
      agent.bus.on("turn.started", ({ replay }) => {
        if (replay !== true) this.turnOpened?.();
      }),
      agent.bus.on("turn.completed", ({ replay }) => {
        if (replay !== true) this.requestTitleOnce();
      }),
      agent.bus.on("queue.changed", () => this.touch()),
      agent.bus.on("memory.decided", ({ decision, replay }) => {
        this.ledger.recordDecision(decision, replay === true);
        this.touch();
      }),
      this.away.follow(agent.bus),
      this.quietRuns.follow(agent.bus),
    ];
    this.unfollow = () => {
      for (const stop of stops) stop();
    };
    this.agent = agent;
  }

  private send(text: string, behavior: SendBehavior, images: readonly ImagePart[] = []): void {
    if (this.agent === undefined) return;
    this.lastSend = this.agent
      .send(text, { behavior, images })
      .then(
        () => undefined,
        (cause: unknown) => this.reportTurnFailure(cause),
      )
      .then(() => this.reportRest());
    this.touch();
  }

  private reportTurnFailure(cause: unknown): void {
    if (this.disposed || cause instanceof QueuedPromptCancelledError) return;
    this.feed.post("error", toError(cause).message);
  }

  private settleAfterTurn(): Promise<void> {
    this.touch();
    return this.settleThenRecordShells()
      .catch((cause: unknown) => {
        if (!this.disposed) this.feed.post("error", toError(cause).message);
      })
      .finally(() => this.refreshLedger());
  }

  private async settleToolBatch(): Promise<readonly Message[] | undefined> {
    const settlement = await this.toolBatchSettle?.();
    if (settlement === undefined || this.disposed) return undefined;
    this.reportSettlement(settlement);
    return settlement.history;
  }

  private async settleThenRecordShells(): Promise<void> {
    const beforeSettling = await this.drainQueuedShellEscapes();
    await this.afterTurn?.();
    const whileSettling = await this.drainQueuedShellEscapes();
    for (const run of [...beforeSettling, ...whileSettling]) await this.recordShell(run);
  }

  private async recordShell(run: ShellRun | undefined): Promise<void> {
    if (run === undefined) return;
    const entryId = await this.ports?.recordShellEscape?.(run.transcript);
    if (entryId !== undefined) this.feed.adoptShellTranscript(run.callId, entryId);
  }

  private async drainQueuedShellEscapes(): Promise<ShellRun[]> {
    const runs: ShellRun[] = [];
    for (;;) {
      const agent = this.agent;
      const next = agent?.queued()[0];
      const command = next === undefined ? undefined : shellEscapeCommand(next.text);
      if (agent === undefined || next === undefined || command === undefined) return runs;
      agent.cancelQueued(next.id);
      runs.push(await this.runShell(command));
    }
  }

  private submitShell(text: string, command: string, behavior: SendBehavior): void {
    if (this.ports?.shellEscape === undefined) {
      this.feed.post("info", noShellNotice);
      return;
    }
    this.editor.remember(text);
    this.navigation.snapToLive();
    const agent = this.agent;
    if (agent?.busy() === true) {
      this.send(text, behavior);
      return;
    }
    this.lastSend = this.runShellNow(agent, command)
      .then(
        (run) => this.recordShell(run),
        (cause: unknown) => this.reportTurnFailure(cause),
      )
      .then(() => this.reportRest());
    this.touch();
  }

  private async runShellNow(
    agent: Agent | undefined,
    command: string,
  ): Promise<ShellRun | undefined> {
    if (agent === undefined) return this.runShell(command);
    let run: ShellRun | undefined;
    await agent.hold(async () => {
      run = await this.runShell(command);
    });
    return run;
  }

  private async runShell(command: string): Promise<ShellRun> {
    const port = this.ports?.shellEscape;
    this.shellSequence += 1;
    const call = shellEscapeCall(command, this.shellSequence);
    const controller = new AbortController();
    this.shellAbort = controller;
    this.feed.beginUserTool(call);
    this.touch();
    const result = await (
      port?.run(call, controller.signal) ?? Promise.resolve(noShellResult)
    ).catch((cause: unknown) => ({ output: toError(cause).message, isError: true }));
    if (this.shellAbort === controller) this.shellAbort = undefined;
    const output = clipToolOutput(result.output);
    this.feed.finishUserTool(call.callId, output, result.isError);
    return { callId: call.callId, transcript: shellEscapeTranscript(command, output) };
  }

  private reportRest(): void {
    if (this.disposed) return;
    if (!this.busy) {
      this.away.turnSettled();
      this.settledListener?.(this.outcome());
      this.offerCompaction();
      this.refreshLedger();
      this.readServedContext();
    }
    this.touch();
  }

  private offerCompaction(): void {
    if (this.compaction === undefined) return;
    if (this.compactionOffer.crossed(this.contextReading())) {
      this.feed.post("info", compactionOfferNotice);
    }
  }

  private setQueueAside(): SendBehavior {
    const aside = this.agent?.clearQueue() ?? [];
    if (aside.length === 0) return "steer";
    this.editor.holdAside(aside.map((prompt) => promptAsTyped(prompt.text)));
    this.feed.post("info", queueAsideNotice(aside.length));
    return "steer";
  }

  private welcomeBack(stretch: AwayStretch | undefined): void {
    if (stretch === undefined || this.disposed) return;
    const digest = awayDigest(stretch, this.entries, this.ask.pending?.summary);
    if (digest !== undefined) this.feed.post("info", digest);
  }

  private withMentionedFiles(prompt: string): string {
    const read = this.ports?.readFile;
    const agent = this.agent;
    if (read === undefined || agent === undefined) return prompt;
    return attachMentionedFiles(prompt, read, agent.history());
  }

  private foldAttachments(): void {
    for (const entry of this.feed.entries) {
      if (entry.kind === "user") entry.text = promptAsTyped(entry.text);
    }
  }

  private askAside(question: string): void {
    const agent = this.agent;
    if (agent === undefined) {
      this.feed.post("info", "no model bound · nothing to ask");
      return;
    }
    if (question === "") {
      this.feed.post("info", "/btw <question> · asks on the side, kept out of the conversation");
      return;
    }
    this.feed.post("info", `btw · ${question}`);
    this.lastAside = answerAside(agent.provider, agent.history(), question).then(
      (answer) => this.postAside(answer === "" ? "(no answer came back)" : answer),
      (cause: unknown) => {
        if (!this.disposed) this.feed.post("info", `btw · no answer · ${toError(cause).message}`);
      },
    );
  }

  private outcome(): SettledOutcome {
    return this.feed.entries.at(-1)?.kind === "error" ? "failed" : "finished";
  }

  private compactNow(instructions: string): void {
    const hook = this.compaction;
    if (this.agent === undefined) {
      this.feed.post("info", "no model bound · nothing to compact");
      return;
    }
    if (hook === undefined) {
      this.feed.post("info", "can't compact · no session store");
      return;
    }
    if (this.busy) {
      this.feed.post("info", "turn still running · compact once it settles");
      return;
    }
    this.lastSend = this.agent
      .hold(() => hook(instructions))
      .catch((cause: unknown) => {
        if (!this.disposed) this.feed.post("error", toError(cause).message);
      })
      .then(() => this.reportRest());
    this.touch();
  }

  private applyEdit(outcome: Exclude<EditorOutcome, "pass">): boolean {
    if (outcome === "handled") return true;
    if ("submit" in outcome) {
      if (this.agent === undefined && shellEscapeCommand(outcome.submit) === undefined) return true;
      this.editor.clear();
      this.submitText(outcome.submit, outcome.behavior, outcome.images);
      return true;
    }
    const ran =
      this.runNamedCommand(outcome.command) ||
      (outcome.chosen !== undefined && this.runNamedCommand(outcome.chosen));
    if (!ran) this.feed.post("error", `unknown command /${outcome.command}`);
    return true;
  }

  private runNamedCommand(typed: string): boolean {
    const [verb = "", ...rest] = typed.split(/\s+/);
    const argument = rest.join(" ").trim();
    switch (verb.toLowerCase()) {
      case "cost":
        this.reportCost();
        return true;
      case "context":
        this.feed.post("info", this.contextReport());
        return true;
      case "compact":
        this.compactNow(argument);
        return true;
      case "thinking":
        this.toggleThinking(argument);
        return true;
      case "effort":
        this.chooseEffort(argument);
        return true;
      case "btw":
        this.askAside(argument);
        return true;
      case "policy":
        return this.reportBotPolicy() || (this.commands?.run(typed) ?? false);
      default:
        return this.commands?.run(typed) ?? false;
    }
  }

  private contextReport(): string {
    const map = this.contextMap();
    return map === undefined ? "no provider · nothing to measure" : contextReadout(map).join("\n");
  }

  private reportBotPolicy(): boolean {
    const bot = this.ledger.bot;
    const entry = bot === undefined ? undefined : this.ports?.botOf?.(bot);
    if (entry === undefined) return false;
    this.feed.post("info", learningPolicyReadout(entry));
    return true;
  }

  private toggleThinking(argument: string): void {
    const agent = this.agent;
    if (agent === undefined) {
      this.feed.post("info", "no model bound · nothing to think with");
      return;
    }
    const requested = thinkingSwitchFrom(argument) ?? (agent.thinking() ? "off" : "on");
    agent.setThinking(requested === "on");
    this.feed.post("info", thinkingNotices[requested]);
    this.lastSend = (this.thinkingChange?.(requested) ?? Promise.resolve()).catch(
      (cause: unknown) => {
        if (!this.disposed) this.feed.post("error", toError(cause).message);
      },
    );
  }

  private chooseEffort(argument: string): void {
    const agent = this.agent;
    if (agent === undefined) {
      this.feed.post("info", "no model bound · nothing to set effort for");
      return;
    }
    const word = argument.trim().toLowerCase();
    if (word === "") {
      this.feed.post(
        "info",
        `effort ${agent.effort() ?? "at the provider default"} · ${effortUsage}`,
      );
      return;
    }
    if (!isEffortLevel(word)) {
      this.feed.post("error", `unknown effort ${word} · ${effortUsage}`);
      return;
    }
    agent.setEffort(word);
    this.feed.post("info", `effort ${word} · from your next prompt on`);
    this.lastSend = (this.effortChange?.(word) ?? Promise.resolve()).catch((cause: unknown) => {
      if (!this.disposed) this.feed.post("error", toError(cause).message);
    });
  }

  private reportCost(): void {
    const report = this.ledger.costReport(this.agent);
    const bot = this.ledger.bot;
    const botSpend = this.ports?.botSpend;
    if (bot === undefined || botSpend === undefined) {
      this.feed.post("info", report);
      return;
    }
    void botSpend(bot).then((summary) => {
      this.feed.post(
        "info",
        summary === undefined ? report : `${report}\n${describeBotSpend(summary)}`,
      );
    });
  }

  private cursoredRun(): ToolRun | undefined {
    const at = this.navigation.viewport().foldCursor;
    const entry = at === undefined ? undefined : this.entries[at];
    return entry?.kind === "tool" ? entry.run : undefined;
  }

  private openCursoredChild(): boolean {
    const run = this.cursoredRun();
    const sessionId = run?.child?.sessionId;
    const open = this.ports?.openSession;
    if (run?.outcome === undefined) this.feed.post("info", childStillRunningNotice);
    else if (sessionId === undefined) this.feed.post("info", unsavedChildNotice);
    else if (open === undefined) this.feed.post("info", noSessionPaneNotice);
    else open(sessionId);
    return true;
  }

  private openCursoredSpill(): boolean {
    const spill = this.cursoredSpill();
    if (spill === undefined) return false;
    const path = this.ports?.spillFile?.(spill.id);
    const open = this.ports?.openFile;
    if (path === undefined) this.feed.post("info", `spill ${spill.id} is not on disk any more`);
    else if (open === undefined) this.feed.post("info", noFilePaneNotice);
    else open(path, { byteRange: { from: spill.elidedFrom, to: spill.elidedTo } });
    return true;
  }

  private handleAskKey(chord: Chord, sequence: string | undefined, askRows: number): boolean {
    if (this.ask.handleKey(chord, askRows, sequence)) return true;
    const edited = this.editor.handleKey(chord, sequence);
    if (edited === "pass") return true;
    this.ask.holdArming();
    return this.applyEdit(edited);
  }

  private handleEscape(primed: boolean): boolean {
    if (this.navigation.scrollBack > 0) return this.navigation.snapToLive();
    if (this.busy) {
      this.shellAbort?.abort();
      this.agent?.interrupt();
      return true;
    }
    if (!this.editor.isEmpty()) return false;
    if (primed) return this.navigation.enterBacktrack();
    this.navigation.primeEscape();
    return true;
  }

  private handleBacktrackKey(
    chord: Chord,
    sequence: string | undefined,
    viewport: KeyViewport,
  ): boolean {
    switch (chord.name) {
      case "escape":
        this.navigation.exitBacktrack();
        return true;
      case "up":
        this.navigation.stepBacktrack(-1);
        return true;
      case "down":
        this.navigation.stepBacktrack(1);
        return true;
      case "return":
      case "enter":
        if (this.navigation.pickerPurpose() === "forget") this.forgetSelectedEntry();
        else this.forkSelectedPrompt();
        return true;
      default:
        this.navigation.exitBacktrack();
        return this.handleKey(chord, sequence, viewport);
    }
  }

  private enterQueueEditing(direction: QueueMove): boolean {
    const count = this.queuedPrompts().length;
    if (count === 0) return false;
    this.queueCursor = direction === -1 ? count - 1 : 0;
    this.touch();
    return true;
  }

  private exitQueueEditing(): void {
    this.queueCursor = undefined;
    this.touch();
  }

  private handleQueueKey(
    chord: Chord,
    sequence: string | undefined,
    viewport: KeyViewport,
  ): boolean {
    switch (chord.name) {
      case "escape":
        this.exitQueueEditing();
        return true;
      case "up":
      case "down": {
        const direction: QueueMove = chord.name === "up" ? -1 : 1;
        return chord.shift ? this.moveSelectedQueued(direction) : this.stepQueueCursor(direction);
      }
      case "backspace":
      case "delete":
        return this.cancelSelectedQueued();
      case "return":
      case "enter":
        return this.promoteSelectedQueued();
      default:
        this.exitQueueEditing();
        return this.handleKey(chord, sequence, viewport);
    }
  }

  private stepQueueCursor(direction: QueueMove): boolean {
    const selected = this.queueSelection();
    if (selected === undefined) return true;
    const last = this.queuedPrompts().length - 1;
    this.queueCursor = Math.min(last, Math.max(0, selected + direction));
    this.touch();
    return true;
  }

  private cancelSelectedQueued(): boolean {
    const prompt = this.selectedQueued();
    if (prompt === undefined) return true;
    this.agent?.cancelQueued(prompt.id);
    if (!this.editingQueue()) this.queueCursor = undefined;
    this.touch();
    return true;
  }

  private moveSelectedQueued(direction: QueueMove): boolean {
    const agent = this.agent;
    const from = this.queueSelection();
    const prompt = this.selectedQueued();
    if (agent === undefined || from === undefined || prompt === undefined) return true;
    if (agent.moveQueued(prompt.id, from + direction) === "moved")
      this.queueCursor = from + direction;
    this.touch();
    return true;
  }

  private promoteSelectedQueued(): boolean {
    const prompt = this.selectedQueued();
    if (prompt === undefined) return true;
    this.agent?.cancelQueued(prompt.id);
    this.exitQueueEditing();
    this.send(prompt.text, "steer");
    return true;
  }

  private selectedQueued(): QueuedPrompt | undefined {
    const selected = this.queueSelection();
    return selected === undefined ? undefined : this.queuedPrompts()[selected];
  }

  private forkSelectedPrompt(): void {
    const prompt = this.navigation.selectedPrompt();
    this.navigation.exitBacktrack();
    if (prompt === undefined) return;
    const fork = this.ports?.forkAtPrompt;
    if (this.busy) {
      this.feed.post("info", "turn still running · esc to interrupt");
    } else if (fork === undefined) {
      this.feed.post("info", "can't fork · no session store");
    } else if (prompt.entryId === undefined) {
      this.feed.post("info", noForkPointNotice);
    } else {
      this.lastFork = fork(prompt.entryId, promptAsTyped(prompt.text)).then(
        (outcome) => this.reportFork(outcome),
        (cause: unknown) => {
          if (!this.disposed) this.feed.post("error", toError(cause).message);
        },
      );
    }
  }

  private forgetSelectedEntry(): void {
    const entry = this.navigation.selectedEntry();
    const replacement = this.forgetReplacement;
    this.navigation.exitBacktrack();
    const pick = entry === undefined ? undefined : forgetPickOf(entry);
    const forget = this.forget;
    if (pick === undefined || forget === undefined) return;
    if (this.busy) {
      this.feed.post("info", turnRunningNotice);
      return;
    }
    this.lastForget = forget(pick.target, replacement, pick.subject).then(
      (outcome) => this.reportForget(outcome),
      (cause: unknown) => {
        if (!this.disposed) this.feed.post("error", toError(cause).message);
      },
    );
  }

  private reportForget(outcome: ForgetOutcome): void {
    if (!this.disposed) this.feed.post("info", outcome.note);
  }

  private reportFork(outcome: ForkOutcome): void {
    if (this.disposed) return;
    if (!outcome.forked) this.feed.post("info", noForkPointNotice);
    else if (outcome.note !== undefined) this.feed.post("info", outcome.note);
  }

  private stageUndo(
    undo: StagedUndo | undefined,
    at: number,
    text: string,
    notice: (filesNote: string) => string,
  ): void {
    if (this.disposed) return;
    if (undo === undefined) {
      this.feed.post("info", nothingToUndoNotice);
      return;
    }
    this.stagedUndo = { undo, at, entries: this.feed.entries.splice(at) };
    this.editor.clearKeepingDraft();
    this.editor.load(text);
    this.navigation.snapToLive();
    this.feed.post("info", notice(undo.filesNote));
    this.refreshLedger();
  }

  private retoldTurns(reopened: ReopenedUndo): TranscriptEntry[] {
    const retold = new TranscriptFeed(() => {}, this.ports?.now);
    retold.expectSummaries(reopened.summaries);
    const bus: Agent["bus"] = new EventBus();
    const stop = retold.follow(bus);
    reopened.retell(bus);
    stop();
    const kept = this.feed.promptIndices().length;
    const from = retold.promptIndices()[kept];
    return from === undefined ? [] : retold.entries.slice(from);
  }

  private unstage(staged: StagedPromptUndo): void {
    if (this.disposed) return;
    const at = staged.at === "end" ? this.feed.entries.length : staged.at;
    this.feed.entries.splice(at, 0, ...staged.entries);
    this.editor.clearKeepingDraft();
    this.feed.post("info", "redone · the turn and its files are back");
    this.refreshLedger();
  }

  private reportUndoFailure(cause: unknown): void {
    if (!this.disposed) this.feed.post("error", toError(cause).message);
  }

  private requestTitleOnce(): void {
    if (this.titleRequested || this.titler === undefined || this.agent === undefined) return;
    this.titleRequested = true;
    this.lastTitle = this.titler(this.agent.history(), this.agent)
      .then((title) => {
        if (title === undefined || this.disposed) return;
        this.title = title;
        this.touch();
      })
      .catch(() => {});
  }
}

const noForkPointNotice = "no fork point there";

const noRestoreNotice = "can't restore · no session store";

const quietOnNotice =
  "quiet · asks this session would grant run without asking, never destructive ones · /quiet ends it";

const quietOffNotice =
  "quiet ends · it revoked nothing, its grants stay · /permissions then r revokes one";

const renameUsage = "/rename <title> · names this session for good, the titler stops";

function undoneNotice(filesNote: string): string {
  return `undone · ${filesNote} · your prompt is back in the composer · /redo brings it all back`;
}

function unknownTurnNotice(turn: number, records: readonly TurnRecord[]): string {
  const last = records.at(-1)?.turn;
  return last === undefined
    ? "no turn has settled here yet"
    : `no turn ${turn} here · turns run 1 to ${last}`;
}

function foldedTurnNotice(turn: number): string {
  return `turn ${turn} is folded into a compaction summary · /tree forks from its entry instead`;
}

interface ShellRun {
  readonly callId: string;
  readonly transcript: string;
}

interface PendingRestore {
  readonly row: LedgerEntry;
  readonly question: string;
}

function queueAsideNotice(count: number): string {
  return `${count === 1 ? "1 queued prompt" : `${count} queued prompts`} set aside · up on an empty prompt brings them back`;
}

const nothingToForgetNotice =
  "nothing to forget yet · prompts and tool results show up here once saved";
const forkPickerHint = "backtrack · ↑ older · ↓ newer · enter edit & fork · esc cancel";
const turnRunningNotice = "turn still running · esc to interrupt";
const alreadyStagedNotice = "already undone · send to keep it or /redo to bring it back";
const nothingToUndoNotice = "nothing to undo here";

interface StagedPromptUndo {
  readonly undo: StagedUndo;
  readonly at: number | "end";
  readonly entries: readonly TranscriptEntry[];
}

function reopenedUndoNotice(filesNote: string): string {
  return `an undo is still staged from last time · ${filesNote} · send to keep it or /redo to bring it all back`;
}
const noShellNotice = "no shell here · ! needs a workspace runtime";
const noFilePaneNotice = "can't open the spill · no file panes here";

const childStillRunningNotice = "the child is still working · o opens it once it's done";
const unsavedChildNotice = "this child wasn't saved, so there's nothing to open";
const noSessionPaneNotice = "can't open the child · no session panes here";

function isOpenKey(chord: Chord): boolean {
  return chord.name === "o" && !chord.ctrl && !chord.meta && !chord.shift;
}
const noShellResult = { output: "no shell here", isError: true } as const;

function queueEntryDirection(chord: Chord): QueueMove | undefined {
  if (!chord.meta || chord.ctrl) return undefined;
  if (chord.name === "up") return -1;
  if (chord.name === "down") return 1;
  return undefined;
}

const thinkingNotices = {
  on: "thinking shown · tab unfolds it · /thinking hides it again",
  off: "thinking hidden · progress notes still show where the model writes them",
} as const;

const effortUsage = `/effort ${effortLevels.join("|")}`;

function thinkingSwitchFrom(argument: string): "on" | "off" | undefined {
  const word = argument.trim().toLowerCase();
  return word === "on" || word === "off" ? word : undefined;
}

const conversationCommands: readonly CommandSuggestion[] = [
  { name: "cost", description: "token and cost breakdown for this session" },
  { name: "context", description: "how full the context is and where compaction fires" },
  { name: "compact", description: "fold older context into a summary: /compact [focus]" },
  { name: "thinking", description: "show or hide the model's reasoning: /thinking [on|off]" },
  {
    name: "effort",
    description: "how much work each reply gets: /effort [low|medium|high|xhigh|max]",
  },
  { name: "btw", description: "ask on the side, kept out of the conversation: /btw <question>" },
];
