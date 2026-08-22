import {
  type Agent,
  addUsage,
  type ContextReading,
  type CostRollup,
  carriesUsage,
  contextBudgetFor,
  declaredContextWindow,
  emptyCostRollup,
  estimateConversationTokens,
  formatCostNanos,
  knownCostNanos,
  type Message,
  mergeCostRollups,
  modelReferenceOf,
  readContext,
  type ToolCallPart,
  type Usage,
} from "@keywork/engine";
import { clampScroll } from "./clamp.ts";
import { contextReadout } from "./context-gauge.ts";
import { type DiffLine, type FileReader, mutationDiff } from "./diff-render.ts";
import { InputBuffer } from "./input-buffer.ts";
import type { Chord } from "./keys.ts";
import { type MarkdownRow, type MarkdownSpan, renderMarkdown } from "./markdown.ts";
import { defaultPageMarks, type PageMarks } from "./marks.ts";
import { inkAt } from "./motion.ts";
import { columnPage, type PageGrammar, proseWidth } from "./page.ts";
import { TailFollow } from "./tail-follow.ts";

export type Titler = (
  conversation: readonly Message[],
  agent: Agent,
) => Promise<string | undefined>;

export const defaultIdleNotice = "no model bound · /connect adds a provider · /model picks one";

export interface CommandSuggestion {
  name: string;
  description: string;
  shortcut?: string;
}

export interface CommandsPort {
  search(query: string): readonly CommandSuggestion[];
  run(name: string): boolean;
}

export type ForkOutcome = { forked: false } | { forked: true; note?: string };

export interface ConversationPorts {
  readFile?: FileReader;
  forkAtPrompt?: (promptId: string, draft: string) => Promise<ForkOutcome>;
  idleNotice?: string;
  now?: () => number;
}

export interface PendingAsk {
  summary: string;
  diff?: DiffLine[];
  resolve(allowed: boolean): void;
}

export interface AskDiffWindow {
  lines: DiffLine[];
  above: number;
  below: number;
}

const suggestionLimit = 5;
const historyLimit = 50;

const conversationCommands: readonly CommandSuggestion[] = [
  { name: "cost", description: "token and cost breakdown for this session" },
  { name: "context", description: "how full the context is and where compaction fires" },
  { name: "compact", description: "fold older context into a summary: /compact [focus]" },
];

export type CompactionHook = (instructions: string) => Promise<void>;

interface ModelLedger {
  usage: Usage;
  cost: CostRollup;
}

export interface ToolRun {
  name: string;
  subject: string;
  args: string;
  replay: boolean;
  startedAtMs: number;
  folded: boolean;
  live?: string | undefined;
  outcome?: "done" | "failed";
  reason?: string;
  durationMs?: number;
  outputChars?: number;
  detail?: string[];
}

export type TranscriptEntry =
  | UserEntry
  | { kind: "assistant"; text: string }
  | { kind: "tool"; text: string; failed: boolean; run?: ToolRun }
  | { kind: "error"; text: string }
  | { kind: "info"; text: string };

export interface UserEntry {
  kind: "user";
  text: string;
  entryId?: string;
}

type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;

export class ConversationModel {
  readonly entries: TranscriptEntry[] = [];
  readonly buffer = new InputBuffer();
  busy = false;
  activity = 0;
  title: string | undefined;
  pendingAsk: PendingAsk | undefined;
  scrollBack = 0;
  askScroll = 0;
  lastSend: Promise<unknown> = Promise.resolve();
  lastTitle: Promise<unknown> = Promise.resolve();
  lastFork: Promise<unknown> = Promise.resolve();
  selectedSuggestion = 0;
  private readonly queue: string[] = [];
  private readonly unidentifiedPrompts: UserEntry[] = [];
  private readonly history: string[] = [];
  private historyIndex: number | undefined;
  private askPageRows = 8;
  private backtrackAt: number | undefined;
  private foldCursor: number | undefined;
  private revealAt: number | undefined;
  private escapePrimed = false;
  private readonly runningTools = new Map<
    string,
    { entry: ToolEntry; run: ToolRun; tail: TailFollow }
  >();
  private streaming: { entry: TranscriptEntry; steps: number } | undefined;
  private readonly wrapCache = new WeakMap<
    TranscriptEntry,
    {
      width: number;
      prose: number;
      gutter: number;
      marks: PageMarks;
      text: string;
      failed: boolean;
      stamp: string;
      folded: boolean;
      lines: TranscriptLine[];
    }
  >();
  private readonly subscriptions: Array<() => void> = [];
  private titleRequested = false;
  private alwaysAllow = false;
  private pageRows = 10;
  private agent: Agent | undefined;
  private afterTurn: (() => Promise<void>) | undefined;
  private compaction: CompactionHook | undefined;
  private readonly ledger = new Map<string, ModelLedger>();
  private contextCache: { agent: Agent; messages: number; reading: ContextReading } | undefined;
  private retrievalDisclosed = false;
  private disposed = false;

  constructor(
    agent: Agent | undefined,
    private readonly notify: () => void,
    private readonly titler?: Titler,
    private readonly commands?: CommandsPort,
    private readonly ports?: ConversationPorts,
  ) {
    this.agent = agent;
    if (agent === undefined) {
      this.entries.push({ kind: "info", text: ports?.idleNotice ?? defaultIdleNotice });
      return;
    }
    this.subscribe(agent);
  }

  private subscribe(agent: Agent): void {
    const notify = this.notify;
    this.subscriptions.push(
      agent.bus.on("turn.started", ({ userText, replay, entryId }) => {
        if (replay !== true) return;
        this.entries.push({
          kind: "user",
          text: userText,
          ...(entryId !== undefined && { entryId }),
        });
        notify();
      }),
      agent.bus.on("turn.delta", ({ delta }) => {
        if (delta.type !== "text") return;
        this.activity += 1;
        this.appendAssistant(delta.text);
        notify();
      }),
      agent.bus.on("tool.started", ({ call, replay }) => {
        this.streaming = undefined;
        const run: ToolRun = {
          name: call.name,
          subject: toolSubject(call.arguments),
          args: compactJson(call.arguments),
          replay: replay === true,
          startedAtMs: this.now(),
          folded: true,
        };
        const entry: ToolEntry = { kind: "tool", text: toolRowText(run), failed: false, run };
        this.runningTools.set(call.callId, { entry, run, tail: new TailFollow() });
        this.entries.push(entry);
        this.activity += 1;
        notify();
      }),
      agent.bus.on("tool.output", ({ chunk, callId }) => {
        const running =
          (callId === undefined ? undefined : this.runningTools.get(callId)) ??
          [...this.runningTools.values()].at(-1);
        if (running === undefined || running.run.replay) return;
        running.tail.push(chunk);
        running.run.live = running.tail.rows(liveLineLimit).at(-1);
        running.entry.text = toolRowText(running.run);
        this.activity += 1;
        notify();
      }),
      agent.bus.on("tool.finished", ({ callId, output, isError }) => {
        this.settleTool(callId, output, isError);
        notify();
      }),
      agent.bus.on("turn.completed", ({ replay }) => {
        this.streaming = undefined;
        if (replay !== true) this.requestTitleOnce();
        notify();
      }),
      agent.bus.on("turn.interrupted", () => {
        this.streaming = undefined;
        this.entries.push({ kind: "info", text: "· interrupted" });
        notify();
      }),
    );
  }

  get input(): string {
    return this.buffer.value;
  }

  adoptTitle(title: string): void {
    this.title = title;
    this.titleRequested = true;
    this.notify();
  }

  adoptPromptId(entryId: string): void {
    const prompt = this.unidentifiedPrompts.shift();
    if (prompt !== undefined) prompt.entryId = entryId;
  }

  usageSummary(): string {
    if (this.agent === undefined) return "";
    const { usage, cost } = this.sessionTotals();
    const known = knownCostNanos(cost);
    if (known !== undefined) return formatCostNanos(known);
    return usage.inputTokens + usage.outputTokens === 0
      ? ""
      : `${usage.inputTokens}▸${usage.outputTokens}`;
  }

  contextReading(): ContextReading | undefined {
    const agent = this.agent;
    if (agent === undefined) return undefined;
    const messages = agent.history().length;
    if (this.contextCache?.agent === agent && this.contextCache.messages === messages) {
      return this.contextCache.reading;
    }
    const reading = readContext(
      estimateConversationTokens(agent.history()),
      contextBudgetFor(declaredContextWindow(agent.provider)),
    );
    this.contextCache = { agent, messages, reading };
    return reading;
  }

  private sessionTotals(): ModelLedger {
    return this.ledgerRows()
      .map(([, entry]) => entry)
      .reduce(addLedgers, { usage: { inputTokens: 0, outputTokens: 0 }, cost: emptyCostRollup() });
  }

  private ledgerRows(): [string, ModelLedger][] {
    const rows = new Map(this.ledger);
    const agent = this.agent;
    if (agent !== undefined) {
      const key = ledgerKey(agent);
      const live = { usage: agent.usage(), cost: agent.cost() };
      const carried = rows.get(key);
      rows.set(key, carried === undefined ? live : addLedgers(carried, live));
    }
    return [...rows].filter(
      ([, entry]) => carriesUsage(entry.usage) || entry.cost.unpricedTurns > 0,
    );
  }

  private retireAgentTotals(agent: Agent): void {
    const key = ledgerKey(agent);
    const live = { usage: agent.usage(), cost: agent.cost() };
    const carried = this.ledger.get(key);
    this.ledger.set(key, carried === undefined ? live : addLedgers(carried, live));
  }

  suggestions(): readonly CommandSuggestion[] {
    const query = this.slashQuery();
    if (query === undefined) return [];
    const needle = query.trim().toLowerCase();
    const local = conversationCommands.filter(({ name }) => name.startsWith(needle));
    const port = this.commands?.search(query) ?? [];
    const localLeads = needle !== "" && local.some(({ name }) => name.startsWith(needle));
    const merged = localLeads ? [...local, ...port] : [...port, ...local];
    return merged.slice(0, suggestionLimit);
  }

  confirmMutation(call: ToolCallPart): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.alwaysAllow) return Promise.resolve(true);
    return new Promise((resolve) => {
      const reader = this.ports?.readFile;
      const diff =
        reader === undefined ? undefined : mutationDiff(call.name, call.arguments, reader);
      this.pendingAsk = {
        summary: `${call.name} ${compactJson(call.arguments)}`,
        ...(diff !== undefined && { diff }),
        resolve,
      };
      this.askScroll = 0;
      this.notify();
    });
  }

  askDiffWindow(rows: number): AskDiffWindow {
    const diff = this.pendingAsk?.diff ?? [];
    this.askPageRows = Math.max(1, rows);
    this.askScroll = Math.min(Math.max(0, this.askScroll), Math.max(0, diff.length - rows));
    const start = this.askScroll;
    const end = Math.min(diff.length, start + rows);
    return { lines: diff.slice(start, end), above: start, below: diff.length - end };
  }

  backtracking(): boolean {
    return this.backtrackAt !== undefined;
  }

  disclosing(): boolean {
    return this.foldCursor !== undefined;
  }

  dispose(): void {
    this.disposed = true;
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions.length = 0;
    this.queue.length = 0;
    this.pendingAsk?.resolve(false);
    this.pendingAsk = undefined;
    this.streaming = undefined;
    this.backtrackAt = undefined;
    this.foldCursor = undefined;
    this.busy = false;
    this.agent?.interrupt();
  }

  queued(): readonly string[] {
    return this.queue;
  }

  visibleTranscript(
    width: number,
    rows: number,
    page: PageGrammar = columnPage,
    marks: PageMarks = defaultPageMarks,
  ): TranscriptLine[] {
    this.pageRows = rows;
    this.revealPending(width, rows, page, marks);
    const lines = this.linesFromEnd(width, rows + this.scrollBack, page, marks);
    this.scrollBack = clampScroll(this.scrollBack, lines.length, rows);
    const end = lines.length - this.scrollBack;
    return lines.slice(Math.max(0, end - rows), end);
  }

  private linesFromEnd(
    width: number,
    needed: number,
    page: PageGrammar,
    marks: PageMarks,
  ): TranscriptLine[] {
    const tail: TranscriptLine[][] = [];
    let count = 0;
    for (let at = this.entries.length - 1; at >= 0 && count < needed; at -= 1) {
      const entry = this.entries[at];
      if (entry === undefined) break;
      const lines = this.wrappedLines(entry, width, page, marks);
      tail.push(this.highlighted(at, lines));
      count += lines.length;
    }
    return tail.reverse().flat();
  }

  private highlighted(at: number, lines: TranscriptLine[]): TranscriptLine[] {
    if (at === this.backtrackAt) return lines.map((line) => ({ ...line, selected: true }));
    if (at !== this.foldCursor) return lines;
    return lines.map((line, index) => (index === 0 ? { ...line, selected: true } : line));
  }

  private revealPending(width: number, rows: number, page: PageGrammar, marks: PageMarks): void {
    const at = this.revealAt;
    if (at === undefined) return;
    this.revealAt = undefined;
    let below = 0;
    for (let index = this.entries.length - 1; index > at; index -= 1) {
      const entry = this.entries[index];
      if (entry === undefined) break;
      below += this.wrappedLines(entry, width, page, marks).length;
    }
    const revealed = this.entries[at];
    const revealedRows =
      revealed === undefined ? 0 : this.wrappedLines(revealed, width, page, marks).length;
    this.scrollBack = Math.max(0, below + revealedRows - rows);
  }

  private wrappedLines(
    entry: TranscriptEntry,
    width: number,
    page: PageGrammar,
    marks: PageMarks,
  ): TranscriptLine[] {
    const failed = entry.kind === "tool" && entry.failed;
    const bodyWidth = Math.max(1, width - railWidth);
    const prose = proseWidth(page, bodyWidth);
    const stamp = this.stampFor(entry, marks);
    const folded = entry.kind === "tool" ? entry.run?.folded !== false : true;
    const cached = this.wrapCache.get(entry);
    if (
      cached !== undefined &&
      cached.width === width &&
      cached.prose === prose &&
      cached.gutter === page.proseGutter &&
      cached.marks === marks &&
      cached.text === entry.text &&
      cached.failed === failed &&
      cached.stamp === stamp &&
      cached.folded === folded
    ) {
      return cached.lines;
    }
    const lines = entryLines(entry, bodyWidth, page, marks).map((line, index) => ({
      ...line,
      stamp: index === 0 ? stamp : railBlank,
      source: entry,
    }));
    this.wrapCache.set(entry, {
      width,
      prose,
      gutter: page.proseGutter,
      marks,
      text: entry.text,
      failed,
      stamp,
      folded,
      lines,
    });
    return lines;
  }

  private stampFor(entry: TranscriptEntry, marks: PageMarks): string {
    switch (entry.kind) {
      case "user":
        return `${marks.voice.user} `;
      case "assistant":
        return entry === this.streaming?.entry
          ? `${inkAt(marks.streamRamp, Math.min(1, this.streaming.steps / streamSettleSteps))} `
          : `${marks.voice.agent} `;
      case "tool":
      case "error":
        return `${marks.voice.machine} `;
      case "info":
        return railBlank;
    }
  }

  paste(text: string): boolean {
    if (this.pendingAsk !== undefined) return true;
    return this.edit(() => this.buffer.insert(text.replace(/\r\n?/g, "\n")));
  }

  scrollBy(delta: number): boolean {
    this.scrollBack = Math.max(0, this.scrollBack + delta);
    this.notify();
    return true;
  }

  handleKey(chord: Chord, sequence: string | undefined): boolean {
    if (this.pendingAsk !== undefined) return this.answerAsk(chord);
    if (this.backtrackAt !== undefined) return this.handleBacktrackKey(chord, sequence);
    if (this.foldCursor !== undefined && chord.name !== "tab") {
      this.exitDisclosure();
      if (chord.name === "escape") return true;
    }
    const primed = this.escapePrimed;
    this.escapePrimed = false;
    if (this.slashQuery() !== undefined && this.handleSlashKey(chord)) return true;
    switch (chord.name) {
      case "escape":
        return this.handleEscape(primed);
      case "return":
      case "enter":
        if (chord.shift) return this.edit(() => this.buffer.newline());
        this.submit();
        return true;
      case "backspace":
        return this.edit(() => this.buffer.backspace());
      case "left":
        return this.moved(() => this.buffer.left());
      case "right":
        return this.moved(() => this.buffer.right());
      case "home":
        return this.moved(() => this.buffer.home());
      case "end":
        return this.moved(() => this.buffer.end());
      case "up":
        return this.lineUpOrHistory(-1);
      case "down":
        return this.lineUpOrHistory(1);
      case "pageup":
        return this.scrollBy(this.pageRows);
      case "pagedown":
        return this.scrollBy(-this.pageRows);
      case "tab":
        if (!this.buffer.isEmpty()) return false;
        return chord.shift ? this.stepFoldCursor() : this.toggleCursoredFold();
      default:
        if (!isPrintable(chord, sequence)) return false;
        return this.edit(() => this.buffer.insert(sequence ?? ""));
    }
  }

  submit(): void {
    const text = this.buffer.value.trim();
    if (text === "" || this.agent === undefined) return;
    this.buffer.clear();
    this.historyIndex = undefined;
    this.selectedSuggestion = 0;
    this.submitText(text);
  }

  submitText(text: string): void {
    const trimmed = text.trim();
    if (trimmed === "" || this.agent === undefined) return;
    this.remember(trimmed);
    if (this.busy) {
      this.queue.push(trimmed);
      this.notify();
      return;
    }
    this.deliver(trimmed);
  }

  currentAgent(): Agent | undefined {
    return this.agent;
  }

  bindAfterTurn(hook: () => Promise<void>): void {
    this.afterTurn = hook;
  }

  bindCompaction(hook: CompactionHook): void {
    this.compaction = hook;
  }

  swapAgent(agent: Agent): void {
    const previous = this.agent;
    if (previous === agent) return;
    if (previous !== undefined) this.retireAgentTotals(previous);
    this.agent = agent;
    if (previous === undefined) this.subscribe(agent);
  }

  discloseRetrieval(text: string): void {
    if (this.disposed || this.retrievalDisclosed) return;
    this.retrievalDisclosed = true;
    this.entries.push({ kind: "info", text });
    this.notify();
  }

  postNotice(text: string): void {
    if (this.disposed) return;
    this.entries.push({ kind: "info", text });
    this.notify();
  }

  private deliver(text: string): void {
    if (this.disposed || this.agent === undefined) return;
    const agent = this.agent;
    const prompt: UserEntry = { kind: "user", text };
    this.entries.push(prompt);
    this.unidentifiedPrompts.push(prompt);
    this.scrollBack = 0;
    this.occupy(() => agent.send(text).then(() => this.afterTurn?.()));
  }

  private occupy(work: () => Promise<void>): void {
    this.busy = true;
    this.lastSend = work()
      .catch((cause: unknown) => {
        if (this.disposed) return;
        this.entries.push({ kind: "error", text: (cause as Error).message });
      })
      .then(() => {
        if (this.disposed) return;
        this.busy = false;
        this.drainQueue();
        this.notify();
      });
    this.notify();
  }

  private compactNow(instructions: string): void {
    const hook = this.compaction;
    if (this.agent === undefined) {
      this.postNotice("no model bound · nothing to compact");
      return;
    }
    if (hook === undefined) {
      this.postNotice("can't compact · no session store");
      return;
    }
    if (this.busy) {
      this.postNotice("turn still running · compact once it settles");
      return;
    }
    this.occupy(() => hook(instructions));
  }

  private drainQueue(): void {
    const next = this.queue.shift();
    if (next === undefined) return;
    this.deliver(next);
  }

  private settleTool(callId: string, output: string, isError: boolean): void {
    const running = this.runningTools.get(callId);
    if (running === undefined) return;
    this.runningTools.delete(callId);
    const { entry, run } = running;
    run.durationMs = Math.max(0, this.now() - run.startedAtMs);
    run.outcome = isError ? "failed" : "done";
    if (isError) run.reason = firstLine(output);
    run.outputChars = output.length;
    run.detail = detailLines(output);
    run.live = undefined;
    entry.failed = isError;
    entry.text = toolRowText(run);
  }

  private now(): number {
    return this.ports?.now?.() ?? Date.now();
  }

  toggleLatestToolFold(): boolean {
    const newest = this.disclosableIndices().at(-1);
    const entry = newest === undefined ? undefined : this.entries[newest];
    return entry === undefined ? false : this.toggleToolFold(entry);
  }

  toggleToolFold(entry: TranscriptEntry): boolean {
    if (entry.kind !== "tool" || entry.run === undefined || entry.run.detail === undefined) {
      return false;
    }
    entry.run.folded = !entry.run.folded;
    this.notify();
    return true;
  }

  private toggleCursoredFold(): boolean {
    const cursored = this.foldCursor === undefined ? undefined : this.entries[this.foldCursor];
    return cursored === undefined ? this.toggleLatestToolFold() : this.toggleToolFold(cursored);
  }

  private stepFoldCursor(): boolean {
    const disclosable = this.disclosableIndices();
    if (disclosable.length === 0) return false;
    const position = disclosable.indexOf(this.foldCursor ?? -1);
    const older = position <= 0 ? disclosable.length - 1 : position - 1;
    this.foldCursor = disclosable[older];
    this.revealAt = this.foldCursor;
    this.notify();
    return true;
  }

  private exitDisclosure(): void {
    this.foldCursor = undefined;
    this.scrollBack = 0;
    this.notify();
  }

  private disclosableIndices(): number[] {
    return this.entries.flatMap((entry, index) =>
      entry.kind === "tool" && entry.run?.detail !== undefined ? [index] : [],
    );
  }

  private handleEscape(primed: boolean): boolean {
    if (this.scrollBack > 0) return this.scrollBy(-this.scrollBack);
    if (this.busy) {
      this.agent?.interrupt();
      return true;
    }
    if (!this.buffer.isEmpty()) return false;
    if (primed) return this.enterBacktrack();
    this.escapePrimed = true;
    return true;
  }

  private enterBacktrack(): boolean {
    const prompts = this.promptIndices();
    const newest = prompts.at(-1);
    if (newest === undefined) return false;
    this.backtrackAt = newest;
    this.revealAt = newest;
    this.notify();
    return true;
  }

  private handleBacktrackKey(chord: Chord, sequence: string | undefined): boolean {
    switch (chord.name) {
      case "escape":
        this.exitBacktrack();
        return true;
      case "up":
        return this.stepBacktrack(-1);
      case "down":
        return this.stepBacktrack(1);
      case "return":
      case "enter":
        return this.selectBacktrack();
      default:
        this.exitBacktrack();
        return this.handleKey(chord, sequence);
    }
  }

  private stepBacktrack(direction: -1 | 1): boolean {
    const prompts = this.promptIndices();
    const position = prompts.indexOf(this.backtrackAt ?? -1);
    if (position === -1) {
      this.exitBacktrack();
      return true;
    }
    const next = position + direction;
    if (next >= prompts.length) {
      this.exitBacktrack();
      return true;
    }
    if (next < 0) return true;
    this.backtrackAt = prompts[next];
    this.revealAt = this.backtrackAt;
    this.notify();
    return true;
  }

  private selectBacktrack(): boolean {
    const at = this.backtrackAt;
    const entry = at === undefined ? undefined : this.entries[at];
    this.exitBacktrack();
    if (entry === undefined || entry.kind !== "user") return true;
    if (this.busy) {
      this.entries.push({ kind: "info", text: "turn still running · esc to interrupt" });
      this.notify();
      return true;
    }
    const fork = this.ports?.forkAtPrompt;
    if (fork === undefined) {
      this.entries.push({ kind: "info", text: "can't fork · no session store" });
      this.notify();
      return true;
    }
    if (entry.entryId === undefined) {
      this.entries.push({ kind: "info", text: noForkPointNotice });
      this.notify();
      return true;
    }
    this.lastFork = fork(entry.entryId, entry.text)
      .then((outcome) => {
        if (this.disposed) return;
        if (!outcome.forked) {
          this.entries.push({ kind: "info", text: noForkPointNotice });
        } else if (outcome.note !== undefined) {
          this.entries.push({ kind: "info", text: outcome.note });
        }
      })
      .catch((cause: unknown) => {
        if (this.disposed) return;
        this.entries.push({ kind: "error", text: (cause as Error).message });
      })
      .then(() => {
        if (!this.disposed) this.notify();
      });
    return true;
  }

  private exitBacktrack(): void {
    this.backtrackAt = undefined;
    this.revealAt = undefined;
    this.scrollBack = 0;
    this.notify();
  }

  private promptIndices(): number[] {
    return this.entries.flatMap((entry, index) => (entry.kind === "user" ? [index] : []));
  }

  private lineUpOrHistory(direction: -1 | 1): boolean {
    if (this.historyIndex === undefined) {
      const moved = direction === -1 ? this.buffer.up() : this.buffer.down();
      if (moved) {
        this.notify();
        return true;
      }
    }
    return this.browseHistory(direction);
  }

  private browseHistory(direction: -1 | 1): boolean {
    if (direction === -1) {
      if (this.historyIndex === undefined) {
        if (!this.buffer.isEmpty() || this.history.length === 0) return false;
        this.historyIndex = this.history.length - 1;
      } else if (this.historyIndex > 0) {
        this.historyIndex -= 1;
      }
      this.recallHistory();
      return true;
    }
    if (this.historyIndex === undefined) return false;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex += 1;
      this.recallHistory();
    } else {
      this.historyIndex = undefined;
      this.buffer.clear();
      this.notify();
    }
    return true;
  }

  private recallHistory(): void {
    if (this.historyIndex === undefined) return;
    this.buffer.load(this.history[this.historyIndex] ?? "");
    this.notify();
  }

  private remember(text: string): void {
    if (this.history.at(-1) === text) return;
    this.history.push(text);
    if (this.history.length > historyLimit) this.history.shift();
  }

  private edit(change: () => void): boolean {
    change();
    this.historyIndex = undefined;
    this.selectedSuggestion = 0;
    this.notify();
    return true;
  }

  private moved(move: () => void): boolean {
    move();
    this.notify();
    return true;
  }

  private answerAsk(chord: Chord): boolean {
    const ask = this.pendingAsk;
    if (ask === undefined) return false;
    if (ask.diff !== undefined && this.scrollAskDiff(chord)) return true;
    const verdict = askVerdict(chord);
    if (verdict === undefined) return true;
    if (verdict === "always") this.alwaysAllow = true;
    const allowed = verdict !== "deny";
    this.pendingAsk = undefined;
    this.askScroll = 0;
    ask.resolve(allowed);
    this.notify();
    return true;
  }

  private scrollAskDiff(chord: Chord): boolean {
    const steps: Record<string, number> = {
      up: -1,
      down: 1,
      pageup: -this.askPageRows,
      pagedown: this.askPageRows,
    };
    const step = steps[chord.name];
    if (step === undefined) return false;
    this.askScroll = Math.max(0, this.askScroll + step);
    this.notify();
    return true;
  }

  private slashQuery(): string | undefined {
    return this.input.startsWith("/") ? this.input.slice(1) : undefined;
  }

  private handleSlashKey(chord: Chord): boolean {
    const suggestions = this.suggestions();
    if (chord.name === "escape") {
      this.buffer.clear();
      this.selectedSuggestion = 0;
      this.notify();
      return true;
    }
    if (chord.name === "up" || chord.name === "down") {
      const step = chord.name === "down" ? 1 : -1;
      const count = Math.max(1, suggestions.length);
      this.selectedSuggestion = (this.selectedSuggestion + step + count) % count;
      this.notify();
      return true;
    }
    if (chord.name === "tab") {
      const chosen = suggestions[this.selectedSuggestion];
      if (chosen !== undefined) {
        this.buffer.load(`/${chosen.name}`);
        this.notify();
      }
      return true;
    }
    if (chord.name === "return" || chord.name === "enter") {
      this.runSlashCommand(suggestions);
      return true;
    }
    return false;
  }

  private runSlashCommand(suggestions: readonly CommandSuggestion[]): void {
    const typed = this.input.slice(1).trim();
    const chosen = suggestions[this.selectedSuggestion]?.name;
    this.buffer.clear();
    this.selectedSuggestion = 0;
    const ran =
      this.runNamedCommand(typed) || (chosen !== undefined && this.runNamedCommand(chosen));
    if (!ran) this.entries.push({ kind: "error", text: `unknown command /${typed}` });
    this.notify();
  }

  private runNamedCommand(typed: string): boolean {
    const [verb = "", ...rest] = typed.split(/\s+/);
    const argument = rest.join(" ").trim();
    switch (verb.toLowerCase()) {
      case "cost":
        this.entries.push({ kind: "info", text: this.costReport() });
        return true;
      case "context":
        this.entries.push({ kind: "info", text: this.contextReport() });
        return true;
      case "compact":
        this.compactNow(argument);
        return true;
      default:
        return this.commands?.run(typed) ?? false;
    }
  }

  private costReport(): string {
    const agent = this.agent;
    if (agent === undefined) return "no provider · nothing to meter";
    const { usage, cost } = this.sessionTotals();
    if (!carriesUsage(usage) && cost.unpricedTurns === 0) {
      return "no usage yet · send a prompt first";
    }
    const rows = this.ledgerRows();
    const perModel =
      rows.length < 2 ? [] : rows.map(([reference, entry]) => modelLine(reference, entry));
    return [tokenLine(usage), costLine(cost, agent.modelId()), ...perModel].join("\n");
  }

  private contextReport(): string {
    const reading = this.contextReading();
    if (reading === undefined) return "no provider · nothing to measure";
    return contextReadout(reading).join("\n");
  }

  private requestTitleOnce(): void {
    if (this.titleRequested || this.titler === undefined || this.agent === undefined) return;
    this.titleRequested = true;
    this.lastTitle = this.titler(this.agent.history(), this.agent)
      .then((title) => {
        if (title === undefined || this.disposed) return;
        this.title = title;
        this.notify();
      })
      .catch(() => {});
  }

  private appendAssistant(text: string): void {
    const last = this.entries.at(-1);
    if (last?.kind === "assistant") {
      last.text += text;
      if (this.streaming?.entry === last) this.streaming.steps += 1;
      return;
    }
    const entry: TranscriptEntry = { kind: "assistant", text };
    this.entries.push(entry);
    this.streaming = { entry, steps: 0 };
  }
}

export interface TranscriptLine {
  kind: TranscriptEntry["kind"];
  failed: boolean;
  text: string;
  spans?: MarkdownSpan[];
  panel?: true;
  selected?: true;
  stamp?: string;
  source?: TranscriptEntry;
}

export const railWidth = 2;
const railBlank = "  ";
const noForkPointNotice = "no fork point there";
const streamSettleSteps = 4;
const liveLineLimit = 120;
const detailLineLimit = 12;

export function transcriptLines(
  entries: readonly TranscriptEntry[],
  width: number,
): TranscriptLine[] {
  return entries.flatMap((entry) => {
    const failed = entry.kind === "tool" && entry.failed;
    const prefixed = entry.kind === "user" ? `› ${entry.text}` : entry.text;
    return prefixed
      .split("\n")
      .flatMap((line) => wrap(line, width))
      .map((text) => ({ kind: entry.kind, failed, text }));
  });
}

function entryLines(
  entry: TranscriptEntry,
  width: number,
  page: PageGrammar,
  marks: PageMarks,
): TranscriptLine[] {
  switch (entry.kind) {
    case "tool":
      return entry.run === undefined
        ? transcriptLines([entry], width)
        : toolEntryLines(entry.run, entry.failed, width, page, marks);
    case "error":
      return transcriptLines([entry], width);
    case "assistant":
      return markdownEntryLines(entry.text, width, page, marks);
    case "user":
    case "info":
      return proseEntryLines(entry, width, page);
  }
}

function toolEntryLines(
  run: ToolRun,
  failed: boolean,
  width: number,
  page: PageGrammar,
  marks: PageMarks,
): TranscriptLine[] {
  const spans = clipSpans(toolRowSpans(run), width);
  const row: TranscriptLine = { kind: "tool", failed, text: spanText(spans), spans };
  if (run.folded || run.detail === undefined) return [row];
  const ruleText = marks.rule.repeat(Math.max(1, Math.min(width, proseWidth(page, width))));
  const rule: TranscriptLine = {
    kind: "tool",
    failed: false,
    text: ruleText,
    spans: [{ text: ruleText, tone: "rule" }],
  };
  const detail = [...(run.args === "{}" ? [] : [run.args]), ...run.detail]
    .flatMap((line) => wrap(line, width))
    .map((text) => ({
      kind: "tool" as const,
      failed: false,
      text,
      spans: [{ text, tone: "meta" as const }],
    }));
  return [row, rule, ...detail];
}

function toolRowSpans(run: ToolRun): MarkdownSpan[] {
  const head = run.subject === "" ? run.name : `${run.name} ${run.subject}`;
  if (run.outcome === undefined) {
    return [
      { text: head, tone: "body" },
      { text: ` · ${run.live ?? "running"}`, tone: "meta" },
    ];
  }
  const meta = [durationText(run), sizeText(run)]
    .filter((part) => part !== undefined)
    .map((part) => ` · ${part}`)
    .join("");
  const spans: MarkdownSpan[] = [
    { text: head, tone: "body" },
    { text: `${meta} · `, tone: "meta" },
    { text: run.outcome, tone: run.outcome === "done" ? "ok" : "bad" },
  ];
  if (run.reason !== undefined && run.reason !== "") {
    spans.push({ text: ` · ${run.reason}`, tone: "meta" });
  }
  return spans;
}

function toolRowText(run: ToolRun): string {
  return spanText(toolRowSpans(run));
}

function toolSubject(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const record = args as Record<string, unknown>;
  const favored = ["path", "file", "filename", "command", "cmd", "url", "query", "name", "pattern"];
  const key =
    favored.find((candidate) => typeof record[candidate] === "string") ??
    Object.keys(record).find((candidate) => typeof record[candidate] === "string");
  if (key === undefined) return "";
  const value = record[key] as string;
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 40 ? `${flat.slice(0, 39)}…` : flat;
}

function durationText(run: ToolRun): string | undefined {
  if (run.replay || run.durationMs === undefined) return undefined;
  if (run.durationMs < 1000) return `${run.durationMs}ms`;
  if (run.durationMs < 60_000) return `${(run.durationMs / 1000).toFixed(1)}s`;
  return `${Math.round(run.durationMs / 60_000)}m`;
}

function sizeText(run: ToolRun): string | undefined {
  if (run.outputChars === undefined || run.outputChars < 1000) return undefined;
  return `${(run.outputChars / 1000).toFixed(1)}k`;
}

function detailLines(output: string): string[] {
  const lines = output.split("\n").map((line) => line.replace(/\s+$/, ""));
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  if (lines.length <= detailLineLimit) return lines;
  return [...lines.slice(0, detailLineLimit), `… ${lines.length - detailLineLimit} more lines`];
}

function spanText(spans: readonly MarkdownSpan[]): string {
  return spans.map((span) => span.text).join("");
}

function clipSpans(spans: readonly MarkdownSpan[], width: number): MarkdownSpan[] {
  const clipped: MarkdownSpan[] = [];
  let used = 0;
  for (const span of spans) {
    const points = Array.from(span.text);
    if (used + points.length <= width) {
      clipped.push({ ...span });
      used += points.length;
      continue;
    }
    const room = Math.max(0, width - used - 1);
    if (room > 0) clipped.push({ ...span, text: points.slice(0, room).join("") });
    clipped.push({ text: "…", tone: "meta" });
    return clipped;
  }
  return clipped;
}

function proseEntryLines(
  entry: TranscriptEntry,
  width: number,
  page: PageGrammar,
): TranscriptLine[] {
  const gutter = " ".repeat(page.proseGutter);
  return entry.text
    .split("\n")
    .flatMap((line) => wrap(line, proseWidth(page, width)))
    .map((text) => ({
      kind: entry.kind,
      failed: false,
      text: text === "" ? "" : `${gutter}${text}`,
    }));
}

function markdownEntryLines(
  text: string,
  width: number,
  page: PageGrammar,
  marks: PageMarks,
): TranscriptLine[] {
  const gutter = " ".repeat(page.proseGutter);
  return renderMarkdown(text, proseWidth(page, width), width, marks).map((row) =>
    markdownLine(row, gutter),
  );
}

function markdownLine(row: MarkdownRow, gutter: string): TranscriptLine {
  const spans =
    row.panel || gutter === "" || row.spans.length === 0
      ? row.spans
      : [{ text: gutter, tone: "body" as const }, ...row.spans];
  return {
    kind: "assistant",
    failed: false,
    text: spans.map((span) => span.text).join(""),
    spans,
    ...(row.panel && { panel: true as const }),
  };
}

function wrap(line: string, width: number): string[] {
  if (width < 1) return [line];
  if (line === "") return [""];
  const points = Array.from(line);
  const pieces: string[] = [];
  for (let at = 0; at < points.length; at += width) {
    pieces.push(points.slice(at, at + width).join(""));
  }
  return pieces;
}

function askVerdict(chord: Chord): "allow" | "always" | "deny" | undefined {
  if (chord.ctrl || chord.meta) return undefined;
  switch (chord.name) {
    case "y":
    case "return":
    case "enter":
      return "allow";
    case "a":
      return "always";
    case "n":
    case "escape":
      return "deny";
    default:
      return undefined;
  }
}

function isPrintable(chord: Chord, sequence: string | undefined): boolean {
  if (sequence === undefined || sequence === "" || chord.ctrl || chord.meta) return false;
  for (const character of sequence) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function tokenLine(usage: Usage): string {
  const parts = [`tokens ${usage.inputTokens}▸${usage.outputTokens}`];
  const read = usage.cacheReadInputTokens ?? 0;
  const written = usage.cacheCreationInputTokens ?? 0;
  if (read > 0) parts.push(`cache read ${read}`);
  if (written > 0) parts.push(`cache write ${written}`);
  return parts.join(" · ");
}

function costLine(cost: CostRollup, modelId: string | undefined): string {
  const known = knownCostNanos(cost);
  if (known !== undefined) return `cost ${formatCostNanos(known)} · ${costBasis(cost, modelId)}`;
  if (cost.pricedTurns > 0) {
    return `cost ${formatCostNanos(cost.nanos)} across ${cost.pricedTurns} priced turns · ${cost.unpricedTurns} more had no pricing`;
  }
  return `cost unknown · no pricing for ${modelId ?? "this model"}`;
}

function costBasis(cost: CostRollup, modelId: string | undefined): string {
  if (cost.meteredTurns === cost.pricedTurns) return "metered by the provider";
  if (cost.meteredTurns > 0) return "partly metered, partly estimated";
  return `estimated from ${modelId ?? "list"} rates`;
}

function modelLine(reference: string, entry: ModelLedger): string {
  const known = knownCostNanos(entry.cost);
  const turns = entry.cost.pricedTurns + entry.cost.unpricedTurns;
  const spend =
    known !== undefined
      ? formatCostNanos(known)
      : entry.cost.pricedTurns > 0
        ? `${formatCostNanos(entry.cost.nanos)} + ${entry.cost.unpricedTurns} unpriced`
        : "no pricing";
  return `  ${reference} · ${turns} ${turns === 1 ? "turn" : "turns"} · ${entry.usage.inputTokens}▸${entry.usage.outputTokens} · ${spend}`;
}

function ledgerKey(agent: Agent): string {
  return modelReferenceOf(agent.provider) ?? agent.provider.name;
}

function addLedgers(left: ModelLedger, right: ModelLedger): ModelLedger {
  return {
    usage: addUsage(left.usage, right.usage),
    cost: mergeCostRollups(left.cost, right.cost),
  };
}

function compactJson(value: unknown): string {
  const text = JSON.stringify(value) ?? "";
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function firstLine(output: string): string {
  const line = output.split("\n", 1)[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}
