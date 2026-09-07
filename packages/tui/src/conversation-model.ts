import {
  type Agent,
  type ContextReading,
  type Message,
  type QueuedPrompt,
  QueuedPromptCancelledError,
  type SendBehavior,
  type ToolCallPart,
} from "@keywork/engine";
import { toError } from "@keywork/shared";
import { type BotEntry, type BotSummary, describeBotSpend, learningPolicyReadout } from "./bots.ts";
import type { FileReader } from "./diff-render.ts";
import type { Chord } from "./keys.ts";
import { defaultPageMarks, type PageMarks } from "./marks.ts";
import { type AskDiffWindow, MutationAsk, type PendingAsk } from "./mutation-ask.ts";
import { columnPage, type PageGrammar } from "./page.ts";
import {
  type CommandSuggestion,
  type CommandsPort,
  type EditorOutcome,
  PromptEditor,
} from "./prompt-editor.ts";
import { SessionLedger } from "./session-ledger.ts";
import {
  type ShellEscapePort,
  shellEscapeCall,
  shellEscapeCommand,
  shellEscapeTranscript,
} from "./shell-escape.ts";
import { type ToolRun, type TranscriptEntry, TranscriptFeed } from "./transcript-feed.ts";
import { TranscriptNavigation } from "./transcript-navigation.ts";
import { type TranscriptLine, TranscriptView } from "./transcript-view.ts";

export type { CommandSuggestion, CommandsPort } from "./prompt-editor.ts";

export type Titler = (
  conversation: readonly Message[],
  agent: Agent,
) => Promise<string | undefined>;

export type ForkOutcome = { forked: false } | { forked: true; note?: string };

export interface ConversationPorts {
  readFile?: FileReader;
  forkAtPrompt?: (promptId: string, draft: string) => Promise<ForkOutcome>;
  idleNotice?: string;
  now?: () => number;
  botSpend?: (bot: string) => Promise<BotSummary | undefined>;
  botOf?: (bot: string) => BotEntry | undefined;
  shellEscape?: ShellEscapePort;
  recordShellEscape?: (transcript: string) => Promise<void>;
}

export type QueueMove = -1 | 1;

export type CompactionHook = (instructions: string) => Promise<void>;

export type ThinkingChangeHook = (level: "on" | "off") => Promise<void>;

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
  title: string | undefined;
  lastSend: Promise<unknown> = Promise.resolve();
  lastTitle: Promise<unknown> = Promise.resolve();
  lastFork: Promise<unknown> = Promise.resolve();
  private readonly ask: MutationAsk;
  private readonly navigation: TranscriptNavigation;
  private readonly view = new TranscriptView();
  private agent: Agent | undefined;
  private unfollow: () => void = () => {};
  private afterTurn: (() => Promise<void>) | undefined;
  private compaction: CompactionHook | undefined;
  private thinkingChange: ThinkingChangeHook | undefined;
  private settledListener: ((outcome: SettledOutcome) => void) | undefined;
  private titleRequested = false;
  private retrievalDisclosed = false;
  private disposed = false;
  private shellSequence = 0;
  private shellAbort: AbortController | undefined;
  private queueCursor: number | undefined;

  constructor(
    agent: Agent | undefined,
    private readonly notify: () => void,
    private readonly titler?: Titler,
    private readonly commands?: CommandsPort,
    private readonly ports?: ConversationPorts,
  ) {
    const touch = () => this.touch();
    this.feed = new TranscriptFeed(touch, ports?.now);
    this.editor = new PromptEditor(touch, conversationCommands, commands);
    this.ask = new MutationAsk(touch, ports?.readFile);
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
    return this.queuedPrompts().map((prompt) => prompt.text);
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

  contextReading(): ContextReading | undefined {
    return this.ledger.contextReading(this.agent);
  }

  activeTool(): ToolRun | undefined {
    return this.feed.activeTool();
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

  visibleTranscript(
    width: number,
    rows: number,
    page: PageGrammar = columnPage,
    marks: PageMarks = defaultPageMarks,
  ): TranscriptLine[] {
    const frame = this.view.frame(
      this.feed,
      { width, rows, page, marks },
      this.navigation.viewport(),
    );
    this.navigation.framed(frame.scrollBack, frame.total);
    return frame.lines;
  }

  handleKey(chord: Chord, sequence: string | undefined, viewport = defaultKeyViewport): boolean {
    if (this.ask.pending !== undefined) return this.ask.handleKey(chord, viewport.askRows);
    if (this.navigation.backtracking()) return this.handleBacktrackKey(chord, sequence, viewport);
    if (this.editingQueue()) return this.handleQueueKey(chord, sequence, viewport);
    if (this.navigation.disclosing() && chord.name !== "tab") {
      this.navigation.exitDisclosure();
      if (chord.name === "escape") return true;
    }
    const primed = this.navigation.takeEscapePrime();
    if (chord.name === "tab" && this.editor.slashQuery() === undefined) {
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
    if (this.ask.pending === undefined) this.editor.paste(text);
    return true;
  }

  scrollBy(delta: number): boolean {
    return this.navigation.scrollBy(delta);
  }

  submitText(text: string, behavior: SendBehavior = "queue"): void {
    const trimmed = text.trim();
    if (trimmed === "" || this.disposed) return;
    const command = shellEscapeCommand(trimmed);
    if (command !== undefined) {
      this.submitShell(trimmed, command, behavior);
      return;
    }
    if (this.agent === undefined) return;
    this.editor.remember(trimmed);
    this.navigation.snapToLive();
    this.send(trimmed, behavior);
  }

  confirmMutation(call: ToolCallPart): Promise<boolean> {
    return this.ask.confirm(call);
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

  bindCompaction(hook: CompactionHook): void {
    this.compaction = hook;
  }

  bindThinkingChange(hook: ThinkingChangeHook): void {
    this.thinkingChange = hook;
  }

  onSettled(listener: (outcome: SettledOutcome) => void): void {
    this.settledListener = listener;
  }

  swapAgent(agent: Agent): void {
    const previous = this.agent;
    if (previous === agent) return;
    if (previous !== undefined) this.ledger.retire(previous);
    if (previous !== undefined) agent.setThinking(previous.thinking());
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

  private follow(agent: Agent): void {
    this.unfollow();
    this.agent?.settleTurnsWith(undefined);
    agent.settleTurnsWith(() => this.settleAfterTurn());
    const stops = [
      this.feed.follow(agent.bus),
      agent.bus.on("turn.completed", ({ replay }) => {
        if (replay !== true) this.requestTitleOnce();
      }),
      agent.bus.on("queue.changed", () => this.touch()),
    ];
    this.unfollow = () => {
      for (const stop of stops) stop();
    };
    this.agent = agent;
  }

  private send(text: string, behavior: SendBehavior): void {
    if (this.agent === undefined) return;
    this.lastSend = this.agent
      .send(text, { behavior })
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
    return this.drainQueuedShellEscapes()
      .then((transcripts) => this.settleThenRecord(transcripts))
      .catch((cause: unknown) => {
        if (!this.disposed) this.feed.post("error", toError(cause).message);
      });
  }

  private async settleThenRecord(transcripts: readonly string[]): Promise<void> {
    await this.afterTurn?.();
    for (const transcript of transcripts) await this.ports?.recordShellEscape?.(transcript);
  }

  private async drainQueuedShellEscapes(): Promise<string[]> {
    const transcripts: string[] = [];
    for (;;) {
      const agent = this.agent;
      const next = agent?.queued()[0];
      const command = next === undefined ? undefined : shellEscapeCommand(next.text);
      if (agent === undefined || next === undefined || command === undefined) return transcripts;
      agent.cancelQueued(next.id);
      transcripts.push(await this.runShell(command));
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
        (transcript) => this.ports?.recordShellEscape?.(transcript),
        (cause: unknown) => this.reportTurnFailure(cause),
      )
      .then(() => this.reportRest());
    this.touch();
  }

  private async runShellNow(agent: Agent | undefined, command: string): Promise<string> {
    if (agent === undefined) return this.runShell(command);
    let transcript = "";
    await agent.hold(async () => {
      transcript = await this.runShell(command);
    });
    return transcript;
  }

  private async runShell(command: string): Promise<string> {
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
    this.feed.finishUserTool(call.callId, result.output, result.isError);
    return shellEscapeTranscript(command, result.output);
  }

  private reportRest(): void {
    if (this.disposed) return;
    if (!this.busy) this.settledListener?.(this.outcome());
    this.touch();
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
      this.submitText(outcome.submit, outcome.behavior);
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
        this.feed.post("info", this.ledger.contextReport(this.agent));
        return true;
      case "compact":
        this.compactNow(argument);
        return true;
      case "thinking":
        this.toggleThinking(argument);
        return true;
      case "policy":
        return this.reportBotPolicy() || (this.commands?.run(typed) ?? false);
      default:
        return this.commands?.run(typed) ?? false;
    }
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
        this.forkSelectedPrompt();
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
    if (agent === undefined || from === undefined) return true;
    const prompts = [...agent.queued()];
    const to = from + direction;
    if (to < 0 || to >= prompts.length) return true;
    const first = Math.min(from, to);
    const reordered = swapped(prompts, from, to).slice(first);
    if (reordered.some((prompt) => prompt.behavior === "steer")) return true;
    for (const prompt of prompts.slice(first)) agent.cancelQueued(prompt.id);
    for (const prompt of reordered) this.send(prompt.text, "queue");
    this.queueCursor = to;
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
      this.lastFork = fork(prompt.entryId, prompt.text).then(
        (outcome) => this.reportFork(outcome),
        (cause: unknown) => {
          if (!this.disposed) this.feed.post("error", toError(cause).message);
        },
      );
    }
  }

  private reportFork(outcome: ForkOutcome): void {
    if (this.disposed) return;
    if (!outcome.forked) this.feed.post("info", noForkPointNotice);
    else if (outcome.note !== undefined) this.feed.post("info", outcome.note);
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
const noShellNotice = "no shell here · ! needs a workspace runtime";
const noShellResult = { output: "no shell here", isError: true } as const;

function queueEntryDirection(chord: Chord): QueueMove | undefined {
  if (!chord.meta || chord.ctrl) return undefined;
  if (chord.name === "up") return -1;
  if (chord.name === "down") return 1;
  return undefined;
}

function swapped<T>(items: readonly T[], from: number, to: number): T[] {
  const copy = [...items];
  const moved = copy[from] as T;
  copy[from] = copy[to] as T;
  copy[to] = moved;
  return copy;
}

const thinkingNotices = {
  on: "thinking shown · tab unfolds it · /thinking hides it again",
  off: "thinking hidden · requests go out as before",
} as const;

function thinkingSwitchFrom(argument: string): "on" | "off" | undefined {
  const word = argument.trim().toLowerCase();
  return word === "on" || word === "off" ? word : undefined;
}

const conversationCommands: readonly CommandSuggestion[] = [
  { name: "cost", description: "token and cost breakdown for this session" },
  { name: "context", description: "how full the context is and where compaction fires" },
  { name: "compact", description: "fold older context into a summary: /compact [focus]" },
  { name: "thinking", description: "show or hide the model's reasoning: /thinking [on|off]" },
];
