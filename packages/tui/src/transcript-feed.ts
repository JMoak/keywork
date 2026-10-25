import {
  type Agent,
  type BusEvent,
  type ChildOutcome,
  childProvenanceOf,
  childTitleOf,
  coalesceDeltas,
  delegateToolName,
  type EngineEvents,
  formatCostNanos,
  frameTick,
  type PermissionDecision,
  type SpillReference,
  type TickScheduler,
  type ToolCallPart,
} from "@keywork/engine";
import type { SpanLinker } from "./file-references.ts";
import { isForgettable } from "./forget.ts";
import type { MarkdownSpan } from "./markdown.ts";
import { defaultPageMarks, type PageMarks } from "./marks.ts";
import { readsAsShellEscapeTranscript } from "./shell-escape.ts";
import { TailFollow } from "./tail-follow.ts";
import {
  defaultVerbosity,
  nextVerbosity,
  type ToolGrouping,
  toolGroups,
  type Verbosity,
} from "./transcript-verbosity.ts";
import type { TurnRecord } from "./turn-ledger.ts";

export type TranscriptEntry =
  | UserEntry
  | AssistantEntry
  | ThinkingEntry
  | ToolEntry
  | LedgerEntry
  | SummaryEntry
  | NoticeEntry;

export interface UserEntry {
  kind: "user";
  text: string;
  entryId?: string;
}

export interface AssistantEntry {
  kind: "assistant";
  text: string;
  progress?: true;
}

export interface ThinkingEntry {
  kind: "thinking";
  text: string;
  folded: boolean;
}

export interface ToolEntry {
  kind: "tool";
  text: string;
  failed: boolean;
  run?: ToolRun;
}

export type SummaryKind = "compaction" | "branch_summary";

export interface SummaryEntry {
  kind: "summary";
  text: string;
  of: SummaryKind;
  folded: boolean;
}

export interface LedgerEntry {
  kind: "ledger";
  text: string;
  prompt: UserEntry;
  folded: boolean;
  record?: TurnRecord;
}

export interface NoticeEntry {
  kind: "info" | "error";
  text: string;
}

export type ToolProvenance = "agent" | "user" | "external";

export type ToolGate = "waiting" | "refused";

export interface ToolRun {
  name: string;
  callId?: string;
  subject: string;
  args: string;
  fullArgs?: string;
  replay: boolean;
  provenance?: ToolProvenance;
  transcriptId?: string;
  startedAtMs: number;
  gate?: ToolGate | undefined;
  folded: boolean;
  live?: string | undefined;
  outcome?: "done" | "failed";
  reason?: string;
  durationMs?: number;
  outputChars?: number;
  detail?: string[];
  spill?: SpillReference;
  child?: ChildMark;
}

export interface ChildMark {
  title: string;
  sessionId?: string;
  bot?: string;
  outcome?: ChildOutcome;
  costNanos?: number;
}

export type TranscriptBus = Agent["bus"];

export class TranscriptFeed {
  readonly entries: TranscriptEntry[] = [];
  activity = 0;
  verbosity: Verbosity = defaultVerbosity;
  link: SpanLinker | undefined;
  onLedgerRow: (() => void) | undefined;
  private readonly ledgered = new WeakSet<UserEntry>();
  private expectedSummaries: { text: string; kind: SummaryKind }[] = [];
  private readonly running = new Map<string, RunningTool>();
  private stream: { entry: AssistantEntry; steps: number } | undefined;
  private turnStartedAtMs: number | undefined;
  private readonly promptsAwaitingId: UserEntry[] = [];

  constructor(
    private readonly notify: () => void,
    private readonly now: () => number = Date.now,
    private readonly tick: TickScheduler = frameTick,
  ) {}

  follow(bus: TranscriptBus): () => void {
    const coalescer = coalesceDeltas((event) => this.absorb(event), this.tick);
    const relay = <K extends FollowedEvent>(type: K) =>
      bus.on(type, (payload: EngineEvents[K]) => {
        const event = { type, payload } as BusEvent;
        if (this.countsAsActivity(event)) this.activity += 1;
        coalescer.push(event);
      });
    const stops = followedEvents.map(relay);
    return () => {
      for (const stop of stops) stop();
      coalescer.flush();
    };
  }

  activeTool(): ToolRun | undefined {
    return [...this.running.values()].map(({ run }) => run).findLast((run) => !run.replay);
  }

  turnElapsedMs(): number | undefined {
    return this.turnStartedAtMs === undefined
      ? undefined
      : Math.max(0, this.now() - this.turnStartedAtMs);
  }

  beginUserTool(call: ToolCallPart): void {
    this.activity += 1;
    this.startTool(call, false, "user");
  }

  finishUserTool(callId: string, output: string, isError: boolean): void {
    this.settleTool({ callId, output, isError });
  }

  adoptShellTranscript(callId: string, entryId: string): void {
    const shell = this.entries.find(
      (entry): entry is ToolEntry => entry.kind === "tool" && entry.run?.callId === callId,
    );
    if (shell?.run !== undefined) shell.run.transcriptId = entryId;
  }

  shellTranscriptIds(): ReadonlySet<string> {
    return new Set(this.entries.flatMap((entry) => this.shellTranscriptIdOf(entry) ?? []));
  }

  ruleOn(decision: PermissionDecision): void {
    const running = this.running.get(decision.callId);
    if (running === undefined) return;
    const { entry, run } = running;
    const granted = decision.verdict === "granted";
    run.gate = granted ? undefined : "refused";
    if (granted) run.startedAtMs = this.now();
    entry.text = toolRowText(run);
    this.notify();
  }

  post(kind: NoticeEntry["kind"], text: string): void {
    this.entries.push({ kind, text });
    this.notify();
  }

  postSummary(of: SummaryKind, text: string): void {
    this.entries.push({ kind: "summary", text, of, folded: true });
    this.notify();
  }

  adoptPromptId(entryId: string): void {
    const prompt = this.promptsAwaitingId.shift();
    if (prompt !== undefined) prompt.entryId = entryId;
  }

  streamingProgress(entry: TranscriptEntry): number | undefined {
    if (this.stream?.entry !== entry) return undefined;
    return Math.min(1, this.stream.steps / streamSettleSteps);
  }

  endStream(): void {
    this.stream = undefined;
  }

  cycleVerbosity(): Verbosity {
    this.verbosity = nextVerbosity(this.verbosity);
    this.notify();
    return this.verbosity;
  }

  toolGrouping(): ToolGrouping {
    return toolGroups(this.entries, this.verbosity);
  }

  toggleFold(entry: TranscriptEntry): boolean {
    if (this.toolGrouping().has(this.entries.indexOf(entry))) return false;
    if (entry.kind === "ledger") return this.toggleLedgerFiles(entry);
    if (entry.kind === "thinking" || entry.kind === "summary") {
      entry.folded = !entry.folded;
      this.notify();
      return true;
    }
    if (entry.kind !== "tool" || entry.run?.detail === undefined) return false;
    entry.run.folded = !entry.run.folded;
    this.notify();
    return true;
  }

  toggleLatestFold(): boolean {
    const newest = this.disclosableIndices().at(-1);
    const entry = newest === undefined ? undefined : this.entries[newest];
    return entry === undefined ? false : this.toggleFold(entry);
  }

  disclosableIndices(): number[] {
    const grouping = this.toolGrouping();
    return this.entries.flatMap((entry, index) =>
      disclosable(entry) && !grouping.has(index) ? [index] : [],
    );
  }

  expectSummaries(summaries: readonly { text: string; kind: SummaryKind }[]): void {
    this.expectedSummaries = [...summaries];
  }

  ledgerRows(): LedgerEntry[] {
    return this.entries.filter((entry): entry is LedgerEntry => entry.kind === "ledger");
  }

  promptIndices(): number[] {
    return this.entries.flatMap((entry, index) => (entry.kind === "user" ? [index] : []));
  }

  forgettableIndices(): number[] {
    return this.entries.flatMap((entry, index) => (isForgettable(entry) ? [index] : []));
  }

  private shellTranscriptIdOf(entry: TranscriptEntry): string | undefined {
    if (entry.kind === "tool") return entry.run?.transcriptId;
    if (entry.kind !== "user" || this.ledgered.has(entry)) return undefined;
    return readsAsShellEscapeTranscript(entry.text) ? entry.entryId : undefined;
  }

  private countsAsActivity(event: BusEvent): boolean {
    switch (event.type) {
      case "turn.delta":
        return (
          event.payload.delta.type === "text" ||
          event.payload.delta.type === "visible-thinking" ||
          event.payload.delta.type === "progress"
        );
      case "tool.started":
        return true;
      case "tool.output":
        return this.liveRun(event.payload.callId) !== undefined;
      default:
        return false;
    }
  }

  private absorb(event: BusEvent): void {
    switch (event.type) {
      case "turn.started": {
        const { userText, replay, entryId } = event.payload;
        this.startTurn(userText, replay === true, entryId);
        break;
      }
      case "turn.delta":
        this.streamDelta(event.payload.delta);
        break;
      case "tool.started":
        this.startTool(event.payload.call, event.payload.replay === true);
        break;
      case "tool.output":
        this.tailTool(event.payload.chunk, event.payload.callId);
        break;
      case "tool.finished":
        this.settleTool(event.payload);
        break;
      case "gate.ask":
        this.awaitAnswer(event.payload.ask.callId);
        break;
      case "gate.permission":
        this.ruleOn(event.payload.decision);
        break;
      case "child.started":
        this.markChild(event.payload.callId, event.payload);
        break;
      case "child.finished":
        this.markChild(event.payload.callId, event.payload);
        break;
      case "turn.completed":
        this.endTurn();
        this.ledgerLatestPrompt();
        break;
      case "turn.interrupted":
        this.endTurn();
        this.post("info", "· interrupted");
        this.ledgerLatestPrompt();
        break;
      default:
        break;
    }
  }

  private streamDelta(delta: EngineEvents["turn.delta"]["delta"]): void {
    if (delta.type === "text") this.streamText(delta.text);
    if (delta.type === "visible-thinking") this.streamThinking(delta.text);
    if (delta.type === "progress") this.postProgress(delta.text);
  }

  private startTurn(text: string, replay: boolean, entryId: string | undefined): void {
    const summary = replay && entryId === undefined ? this.takeSummary(text) : undefined;
    if (summary !== undefined) {
      this.postSummary(summary, text);
      return;
    }
    const prompt: UserEntry = { kind: "user", text, ...(entryId !== undefined && { entryId }) };
    this.entries.push(prompt);
    if (!replay) {
      this.promptsAwaitingId.push(prompt);
      this.turnStartedAtMs = this.now();
    }
    this.notify();
  }

  private endTurn(): void {
    this.endStream();
    this.turnStartedAtMs = undefined;
  }

  private takeSummary(text: string): SummaryKind | undefined {
    const at = this.expectedSummaries.findIndex((summary) => summary.text === text);
    if (at === -1) return undefined;
    return this.expectedSummaries.splice(at, 1)[0]?.kind;
  }

  private ledgerLatestPrompt(): void {
    const prompt = this.entries.findLast((entry): entry is UserEntry => entry.kind === "user");
    if (prompt === undefined || this.ledgered.has(prompt)) return;
    this.ledgered.add(prompt);
    this.entries.push({ kind: "ledger", text: "", prompt, folded: true });
    this.onLedgerRow?.();
    this.notify();
  }

  private toggleLedgerFiles(entry: LedgerEntry): boolean {
    if ((entry.record?.files ?? []).length === 0) return false;
    entry.folded = !entry.folded;
    this.notify();
    return true;
  }

  private streamText(text: string): void {
    const last = this.entries.at(-1);
    if (last?.kind === "assistant" && last.progress !== true) {
      last.text += text;
      if (this.stream?.entry === last) this.stream.steps += 1;
    } else {
      const entry: AssistantEntry = { kind: "assistant", text };
      this.entries.push(entry);
      this.stream = { entry, steps: 0 };
    }
    this.notify();
  }

  private postProgress(text: string): void {
    this.endStream();
    this.entries.push({ kind: "assistant", text, progress: true });
    this.notify();
  }

  private streamThinking(text: string): void {
    const last = this.entries.at(-1);
    if (last?.kind === "thinking") last.text += text;
    else this.entries.push({ kind: "thinking", text, folded: true });
    this.notify();
  }

  private startTool(call: ToolCallPart, replay: boolean, provenance?: ToolProvenance): void {
    this.endStream();
    const run: ToolRun = {
      name: call.name,
      callId: call.callId,
      subject: toolSubject(call.arguments),
      args: compactJson(call.arguments),
      fullArgs: JSON.stringify(call.arguments) ?? "",
      replay,
      ...(provenance !== undefined && { provenance }),
      startedAtMs: this.now(),
      folded: true,
      ...(call.name === delegateToolName && { child: childMarkOf(call.arguments) }),
    };
    const entry: ToolEntry = { kind: "tool", text: toolRowText(run), failed: false, run };
    this.running.set(call.callId, { entry, run, tail: new TailFollow() });
    this.entries.push(entry);
    this.notify();
  }

  private awaitAnswer(callId: string): void {
    const running = this.running.get(callId);
    if (running === undefined) return;
    running.run.gate = "waiting";
    running.entry.text = toolRowText(running.run);
    this.notify();
  }

  private markChild(
    callId: string,
    news: Pick<ChildMark, "sessionId" | "bot" | "costNanos">,
  ): void {
    const running = this.running.get(callId);
    const child = running?.run.child;
    if (running === undefined || child === undefined) return;
    if (news.sessionId !== undefined) child.sessionId = news.sessionId;
    if (news.bot !== undefined) child.bot = news.bot;
    if (news.costNanos !== undefined) child.costNanos = news.costNanos;
    running.entry.text = toolRowText(running.run);
    this.notify();
  }

  private liveRun(callId: string | undefined): RunningTool | undefined {
    const running =
      (callId === undefined ? undefined : this.running.get(callId)) ??
      [...this.running.values()].at(-1);
    return running === undefined || running.run.replay ? undefined : running;
  }

  private tailTool(chunk: string, callId: string | undefined): void {
    const running = this.liveRun(callId);
    if (running === undefined) return;
    running.tail.push(chunk);
    running.run.live = running.tail.rows(liveLineLimit).at(-1);
    running.entry.text = toolRowText(running.run);
    this.notify();
  }

  private settleTool({ callId, output, isError, spill }: EngineEvents["tool.finished"]): void {
    const running = this.running.get(callId);
    if (running === undefined) return;
    this.running.delete(callId);
    const { entry, run } = running;
    if (run.gate !== "refused") run.durationMs = Math.max(0, this.now() - run.startedAtMs);
    run.outcome = isError ? "failed" : "done";
    if (isError && run.child === undefined) run.reason = firstLine(output);
    run.outputChars = spill?.bytes ?? output.length;
    run.detail = detailLines(output);
    run.live = undefined;
    if (run.child !== undefined) settleChild(run, run.child, output);
    if (spill !== undefined) run.spill = spill;
    if (carriesUntrustedRecall(run.name, output)) run.provenance = "external";
    entry.failed = isError;
    entry.text = toolRowText(run);
    this.notify();
  }
}

export function toolRowSpans(run: ToolRun, marks: PageMarks = defaultPageMarks): MarkdownSpan[] {
  if (run.child !== undefined) return childRowSpans(run, run.child, marks.lineage);
  const head = run.subject === "" ? run.name : `${run.name} ${run.subject}`;
  if (run.outcome === undefined) {
    return [
      { text: head, tone: "body" },
      { text: ` · ${run.live ?? liveWord(run)}`, tone: "meta" },
    ];
  }
  const meta = [durationText(run), sizeText(run), elisionText(run)]
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

export function childRowSpans(run: ToolRun, child: ChildMark, lineage: string): MarkdownSpan[] {
  const head = `${lineage} ${child.bot ?? "child"} · ${child.title}`;
  if (run.outcome === undefined) {
    return [
      { text: head, tone: "body" },
      { text: ` · ${run.live ?? "starting"}`, tone: "meta" },
    ];
  }
  const meta = [durationText(run), costText(child)]
    .filter((part) => part !== undefined)
    .map((part) => ` · ${part}`)
    .join("");
  const word = childOutcomeWords[child.outcome ?? fallbackOutcome(run)];
  return [
    { text: head, tone: "body" },
    { text: `${meta} · `, tone: "meta" },
    { text: word, tone: word === "done" ? "ok" : "bad" },
  ];
}

export function thinkingRowSpans(entry: ThinkingEntry): MarkdownSpan[] {
  return [{ text: `thinking · ${wordCount(entry.text)}`, tone: "meta" }];
}

export function summaryRowSpans(entry: SummaryEntry): MarkdownSpan[] {
  return [{ text: `${summaryWords[entry.of]} · ${wordCount(entry.text)}`, tone: "meta" }];
}

const summaryWords: Record<SummaryKind, string> = {
  compaction: "compacted history",
  branch_summary: "branch summary",
};

export function compactJson(value: unknown): string {
  const text = JSON.stringify(value) ?? "";
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

interface RunningTool {
  entry: ToolEntry;
  run: ToolRun;
  tail: TailFollow;
}

const followedEvents = [
  "turn.started",
  "turn.delta",
  "tool.started",
  "tool.output",
  "tool.finished",
  "gate.ask",
  "gate.permission",
  "child.started",
  "child.finished",
  "turn.completed",
  "turn.interrupted",
] as const;

type FollowedEvent = (typeof followedEvents)[number];

const streamSettleSteps = 4;
const liveLineLimit = 120;
const detailLineLimit = 12;

function disclosable(entry: TranscriptEntry): boolean {
  if (entry.kind === "thinking" || entry.kind === "summary") return true;
  if (entry.kind === "ledger") return entry.record !== undefined;
  if (entry.kind !== "tool") return false;
  return entry.run?.detail !== undefined || entry.run?.child !== undefined;
}

const childOutcomeWords: Record<ChildOutcome, string> = {
  completed: "done",
  interrupted: "stopped",
  failed: "failed",
  denied: "refused",
};

function fallbackOutcome(run: ToolRun): ChildOutcome {
  return run.outcome === "done" ? "completed" : "failed";
}

function childMarkOf(args: unknown): ChildMark {
  const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const named = typeof record.title === "string" ? childTitleOf(record.title) : "";
  const title = named === "" ? "child" : named;
  return { title, ...(typeof record.bot === "string" && { bot: record.bot }) };
}

function settleChild(run: ToolRun, child: ChildMark, output: string): void {
  const provenance = childProvenanceOf(output);
  if (provenance === undefined) return;
  child.outcome = provenance.outcome;
  if (provenance.sessionId !== undefined) child.sessionId = provenance.sessionId;
  if (provenance.bot !== undefined) child.bot = provenance.bot;
  run.detail = detailLines(answerOf(output));
}

function answerOf(delegateResult: string): string {
  return delegateResult.split("\n").slice(2).join("\n");
}

function costText(child: ChildMark): string | undefined {
  return child.costNanos === undefined ? undefined : formatCostNanos(child.costNanos);
}

const recallTools: ReadonlySet<string> = new Set(["memory_get", "memory_search"]);

const untrustedRecallLine =
  /^(?:\[\[[^\]\n]*\]\] · provenance: untrusted\b|(?:- daily\/\S+ |\s*\d+\t)\d{2}:\d{2} \[untrusted\])/m;

function carriesUntrustedRecall(toolName: string, output: string): boolean {
  return recallTools.has(toolName) && untrustedRecallLine.test(output);
}

function wordCount(text: string): string {
  const words = text.split(/\s+/).filter((word) => word !== "").length;
  return words === 1 ? "1 word" : `${words} words`;
}

function toolRowText(run: ToolRun): string {
  return toolRowSpans(run)
    .map((span) => span.text)
    .join("");
}

export function toolSubject(args: unknown): string {
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

function liveWord(run: ToolRun): string {
  return run.gate === "waiting" ? "waiting for you" : "running";
}

function durationText(run: ToolRun): string | undefined {
  if (run.replay || run.durationMs === undefined) return undefined;
  if (run.durationMs < 1000) return `${run.durationMs}ms`;
  if (run.durationMs < 60_000) return `${(run.durationMs / 1000).toFixed(1)}s`;
  return `${Math.round(run.durationMs / 60_000)}m`;
}

function sizeText(run: ToolRun): string | undefined {
  if (run.outputChars === undefined || run.outputChars < 1000) return undefined;
  if (run.outputChars < 1_000_000) return `${(run.outputChars / 1000).toFixed(1)}k`;
  return `${(run.outputChars / 1_000_000).toFixed(1)}M`;
}

function elisionText(run: ToolRun): string | undefined {
  const spill = run.spill;
  return spill === undefined ? undefined : `elided ${spill.elidedFrom}..${spill.elidedTo}`;
}

function detailLines(output: string): string[] {
  const lines = output.split("\n").map((line) => line.replace(/\s+$/, ""));
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  if (lines.length <= detailLineLimit) return lines;
  return [...lines.slice(0, detailLineLimit), `… ${lines.length - detailLineLimit} more lines`];
}

function firstLine(output: string): string {
  const line = output.split("\n", 1)[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}
