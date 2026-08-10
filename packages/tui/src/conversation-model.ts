import type { Agent, Message, ToolCallPart } from "@keywork/engine";
import { clampScroll } from "./clamp.ts";
import { type DiffLine, type FileReader, mutationDiff } from "./diff-render.ts";
import { InputBuffer } from "./input-buffer.ts";
import type { Chord } from "./keys.ts";
import { TailFollow } from "./tail-follow.ts";

export type Titler = (conversation: readonly Message[]) => Promise<string | undefined>;

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
  forkAtPrompt?: (promptOrdinal: number, draft: string) => Promise<ForkOutcome>;
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

export type TranscriptEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; text: string; failed: boolean }
  | { kind: "error"; text: string }
  | { kind: "info"; text: string };

export class ConversationModel {
  readonly entries: TranscriptEntry[] = [];
  readonly buffer = new InputBuffer();
  busy = false;
  title: string | undefined;
  pendingAsk: PendingAsk | undefined;
  scrollBack = 0;
  askScroll = 0;
  lastSend: Promise<unknown> = Promise.resolve();
  lastTitle: Promise<unknown> = Promise.resolve();
  lastFork: Promise<unknown> = Promise.resolve();
  selectedSuggestion = 0;
  private readonly queue: string[] = [];
  private readonly history: string[] = [];
  private historyIndex: number | undefined;
  private tailFollow: TailFollow | undefined;
  private askPageRows = 8;
  private backtrackAt: number | undefined;
  private backtrackMoved = false;
  private escapePrimed = false;
  private readonly runningTools = new Map<string, { entry: TranscriptEntry; name: string }>();
  private readonly wrapCache = new WeakMap<
    TranscriptEntry,
    { width: number; text: string; failed: boolean; lines: TranscriptLine[] }
  >();
  private readonly subscriptions: Array<() => void> = [];
  private titleRequested = false;
  private alwaysAllow = false;
  private pageRows = 10;
  private agent: Agent | undefined;
  private afterTurn: (() => Promise<void>) | undefined;
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
      this.entries.push({
        kind: "info",
        text: "no provider configured — set KEYWORK_OPENROUTER_API_KEY and relaunch",
      });
      return;
    }
    this.subscriptions.push(
      agent.bus.on("turn.started", ({ userText, replay }) => {
        if (replay !== true) return;
        this.entries.push({ kind: "user", text: userText });
        notify();
      }),
      agent.bus.on("turn.delta", ({ delta }) => {
        if (delta.type !== "text") return;
        this.appendAssistant(delta.text);
        notify();
      }),
      agent.bus.on("tool.started", ({ call, replay }) => {
        const entry: TranscriptEntry = {
          kind: "tool",
          text: `· ${call.name} ${compactJson(call.arguments)}`,
          failed: false,
        };
        this.runningTools.set(call.callId, { entry, name: call.name });
        this.entries.push(entry);
        this.tailFollow = replay === true ? undefined : new TailFollow();
        notify();
      }),
      agent.bus.on("tool.output", ({ chunk }) => {
        this.tailFollow?.push(chunk);
        notify();
      }),
      agent.bus.on("tool.finished", ({ callId, output, isError }) => {
        this.settleTool(callId, output, isError);
        this.tailFollow = undefined;
        notify();
      }),
      agent.bus.on("turn.completed", () => {
        this.tailFollow = undefined;
        this.requestTitleOnce();
        notify();
      }),
      agent.bus.on("turn.interrupted", () => {
        this.tailFollow = undefined;
        this.entries.push({ kind: "info", text: "— interrupted" });
        notify();
      }),
    );
  }

  get input(): string {
    return this.buffer.value;
  }

  usageSummary(): string {
    if (this.agent === undefined) return "";
    const { inputTokens, outputTokens } = this.agent.usage();
    return inputTokens + outputTokens === 0 ? "" : `${inputTokens}▸${outputTokens}`;
  }

  suggestions(): readonly CommandSuggestion[] {
    const query = this.slashQuery();
    if (query === undefined || this.commands === undefined) return [];
    return this.commands.search(query).slice(0, suggestionLimit);
  }

  confirmMutation(call: ToolCallPart): Promise<boolean> {
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

  dispose(): void {
    this.disposed = true;
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions.length = 0;
    this.queue.length = 0;
    this.pendingAsk?.resolve(false);
    this.pendingAsk = undefined;
    this.tailFollow = undefined;
    this.backtrackAt = undefined;
    this.busy = false;
    this.agent?.interrupt();
  }

  queued(): readonly string[] {
    return this.queue;
  }

  visibleTranscript(width: number, rows: number): TranscriptLine[] {
    this.pageRows = rows;
    this.revealBacktrack(width, rows);
    const lines = [...this.linesFromEnd(width, rows + this.scrollBack), ...this.tailLines(width)];
    this.scrollBack = clampScroll(this.scrollBack, lines.length, rows);
    const end = lines.length - this.scrollBack;
    return lines.slice(Math.max(0, end - rows), end);
  }

  private linesFromEnd(width: number, needed: number): TranscriptLine[] {
    const tail: TranscriptLine[][] = [];
    let count = 0;
    for (let at = this.entries.length - 1; at >= 0 && count < needed; at -= 1) {
      const entry = this.entries[at];
      if (entry === undefined) break;
      const lines = this.wrappedLines(entry, width);
      tail.push(
        at === this.backtrackAt ? lines.map((line) => ({ ...line, selected: true })) : lines,
      );
      count += lines.length;
    }
    return tail.reverse().flat();
  }

  private tailLines(width: number): TranscriptLine[] {
    if (this.tailFollow === undefined || this.runningTools.size === 0) return [];
    const mark = this.tailFollow.mark();
    return this.tailFollow
      .rows(Math.max(1, width - 2))
      .map((text) => ({ kind: "tail" as const, failed: false, text: `${mark} ${text}` }));
  }

  private revealBacktrack(width: number, rows: number): void {
    const at = this.backtrackAt;
    if (at === undefined || !this.backtrackMoved) return;
    this.backtrackMoved = false;
    let below = 0;
    for (let index = this.entries.length - 1; index > at; index -= 1) {
      const entry = this.entries[index];
      if (entry === undefined) break;
      below += this.wrappedLines(entry, width).length;
    }
    const selected = this.entries[at];
    const selectedRows = selected === undefined ? 0 : this.wrappedLines(selected, width).length;
    this.scrollBack = Math.max(0, below + selectedRows - rows);
  }

  private wrappedLines(entry: TranscriptEntry, width: number): TranscriptLine[] {
    const failed = entry.kind === "tool" && entry.failed;
    const cached = this.wrapCache.get(entry);
    if (
      cached !== undefined &&
      cached.width === width &&
      cached.text === entry.text &&
      cached.failed === failed
    ) {
      return cached.lines;
    }
    const lines = transcriptLines([entry], width);
    this.wrapCache.set(entry, { width, text: entry.text, failed, lines });
    return lines;
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

  swapAgent(agent: Agent): void {
    this.agent = agent;
  }

  discloseRetrieval(text: string): void {
    if (this.retrievalDisclosed) return;
    this.retrievalDisclosed = true;
    this.entries.push({ kind: "info", text });
    this.notify();
  }

  private deliver(text: string): void {
    if (this.agent === undefined) return;
    const agent = this.agent;
    this.entries.push({ kind: "user", text });
    this.busy = true;
    this.scrollBack = 0;
    this.lastSend = agent
      .send(text)
      .then(() => this.afterTurn?.())
      .catch((cause: unknown) => {
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

  private drainQueue(): void {
    const next = this.queue.shift();
    if (next === undefined) return;
    this.deliver(next);
  }

  private settleTool(callId: string, output: string, isError: boolean): void {
    const running = this.runningTools.get(callId);
    if (running === undefined) return;
    this.runningTools.delete(callId);
    running.entry.text = `${isError ? "✗" : "✓"} ${running.name} — ${firstLine(output)}`;
    if (running.entry.kind === "tool") running.entry.failed = isError;
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
    this.backtrackMoved = true;
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
    this.backtrackMoved = true;
    this.notify();
    return true;
  }

  private selectBacktrack(): boolean {
    const at = this.backtrackAt;
    const entry = at === undefined ? undefined : this.entries[at];
    const ordinal = at === undefined ? -1 : this.promptIndices().indexOf(at);
    this.exitBacktrack();
    if (entry === undefined || entry.kind !== "user" || ordinal < 0) return true;
    if (this.busy) {
      this.entries.push({ kind: "info", text: "a turn is running — esc interrupts it first" });
      this.notify();
      return true;
    }
    const fork = this.ports?.forkAtPrompt;
    if (fork === undefined) {
      this.entries.push({ kind: "info", text: "backtrack fork unavailable — no session port" });
      this.notify();
      return true;
    }
    this.lastFork = fork(ordinal, entry.text)
      .then((outcome) => {
        if (!outcome.forked) {
          this.entries.push({ kind: "info", text: "could not fork at that prompt" });
        } else if (outcome.note !== undefined) {
          this.entries.push({ kind: "info", text: outcome.note });
        }
      })
      .catch((cause: unknown) => {
        this.entries.push({ kind: "error", text: (cause as Error).message });
      })
      .then(() => this.notify());
    return true;
  }

  private exitBacktrack(): void {
    this.backtrackAt = undefined;
    this.backtrackMoved = false;
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
    if (chord.name === "a") this.alwaysAllow = true;
    const allowed = ["y", "a", "return", "enter"].includes(chord.name);
    if (!allowed && chord.name !== "n" && chord.name !== "escape") return true;
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
    if (this.commands === undefined) return;
    const typed = this.input.slice(1).trim();
    const chosen = suggestions[this.selectedSuggestion]?.name;
    this.buffer.clear();
    this.selectedSuggestion = 0;
    const ran = this.commands.run(typed) || (chosen !== undefined && this.commands.run(chosen));
    if (!ran) this.entries.push({ kind: "error", text: `unknown command /${typed}` });
    this.notify();
  }

  private requestTitleOnce(): void {
    if (this.titleRequested || this.titler === undefined || this.agent === undefined) return;
    this.titleRequested = true;
    this.lastTitle = this.titler(this.agent.history())
      .then((title) => {
        if (title === undefined) return;
        this.title = title;
        this.notify();
      })
      .catch(() => {});
  }

  private appendAssistant(text: string): void {
    const last = this.entries.at(-1);
    if (last?.kind === "assistant") {
      last.text += text;
      return;
    }
    this.entries.push({ kind: "assistant", text });
  }
}

export interface TranscriptLine {
  kind: TranscriptEntry["kind"] | "tail";
  failed: boolean;
  text: string;
  selected?: true;
}

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

function isPrintable(chord: Chord, sequence: string | undefined): boolean {
  if (sequence === undefined || sequence === "" || chord.ctrl || chord.meta) return false;
  for (const character of sequence) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function compactJson(value: unknown): string {
  const text = JSON.stringify(value) ?? "";
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function firstLine(output: string): string {
  const line = output.split("\n", 1)[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}
