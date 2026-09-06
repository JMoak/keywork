import type { Agent, ToolCallPart } from "@keywork/engine";
import type { MarkdownSpan } from "./markdown.ts";
import { TailFollow } from "./tail-follow.ts";

export type TranscriptEntry = UserEntry | AssistantEntry | ToolEntry | NoticeEntry;

export interface UserEntry {
  kind: "user";
  text: string;
  entryId?: string;
}

export interface AssistantEntry {
  kind: "assistant";
  text: string;
}

export interface ToolEntry {
  kind: "tool";
  text: string;
  failed: boolean;
  run?: ToolRun;
}

export interface NoticeEntry {
  kind: "info" | "error";
  text: string;
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

export type TranscriptBus = Agent["bus"];

export class TranscriptFeed {
  readonly entries: TranscriptEntry[] = [];
  activity = 0;
  private readonly running = new Map<string, RunningTool>();
  private stream: { entry: AssistantEntry; steps: number } | undefined;
  private turnStartedAtMs: number | undefined;
  private readonly promptsAwaitingId: UserEntry[] = [];

  constructor(
    private readonly notify: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  follow(bus: TranscriptBus): () => void {
    const stops = [
      bus.on("turn.started", ({ userText, replay, entryId }) =>
        this.startTurn(userText, replay === true, entryId),
      ),
      bus.on("turn.delta", ({ delta }) => {
        if (delta.type === "text") this.streamText(delta.text);
      }),
      bus.on("tool.started", ({ call, replay }) => this.startTool(call, replay === true)),
      bus.on("tool.output", ({ chunk, callId }) => this.tailTool(chunk, callId)),
      bus.on("tool.finished", ({ callId, output, isError }) =>
        this.settleTool(callId, output, isError),
      ),
      bus.on("turn.completed", () => this.endTurn()),
      bus.on("turn.interrupted", () => {
        this.endTurn();
        this.post("info", "· interrupted");
      }),
    ];
    return () => {
      for (const stop of stops) stop();
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

  post(kind: NoticeEntry["kind"], text: string): void {
    this.entries.push({ kind, text });
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

  toggleFold(entry: TranscriptEntry): boolean {
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
    return this.entries.flatMap((entry, index) =>
      entry.kind === "tool" && entry.run?.detail !== undefined ? [index] : [],
    );
  }

  promptIndices(): number[] {
    return this.entries.flatMap((entry, index) => (entry.kind === "user" ? [index] : []));
  }

  private startTurn(text: string, replay: boolean, entryId: string | undefined): void {
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

  private streamText(text: string): void {
    this.activity += 1;
    const last = this.entries.at(-1);
    if (last?.kind === "assistant") {
      last.text += text;
      if (this.stream?.entry === last) this.stream.steps += 1;
    } else {
      const entry: AssistantEntry = { kind: "assistant", text };
      this.entries.push(entry);
      this.stream = { entry, steps: 0 };
    }
    this.notify();
  }

  private startTool(call: ToolCallPart, replay: boolean): void {
    this.endStream();
    const run: ToolRun = {
      name: call.name,
      subject: toolSubject(call.arguments),
      args: compactJson(call.arguments),
      replay,
      startedAtMs: this.now(),
      folded: true,
    };
    const entry: ToolEntry = { kind: "tool", text: toolRowText(run), failed: false, run };
    this.running.set(call.callId, { entry, run, tail: new TailFollow() });
    this.entries.push(entry);
    this.activity += 1;
    this.notify();
  }

  private tailTool(chunk: string, callId: string | undefined): void {
    const running =
      (callId === undefined ? undefined : this.running.get(callId)) ??
      [...this.running.values()].at(-1);
    if (running === undefined || running.run.replay) return;
    running.tail.push(chunk);
    running.run.live = running.tail.rows(liveLineLimit).at(-1);
    running.entry.text = toolRowText(running.run);
    this.activity += 1;
    this.notify();
  }

  private settleTool(callId: string, output: string, isError: boolean): void {
    const running = this.running.get(callId);
    if (running === undefined) return;
    this.running.delete(callId);
    const { entry, run } = running;
    run.durationMs = Math.max(0, this.now() - run.startedAtMs);
    run.outcome = isError ? "failed" : "done";
    if (isError) run.reason = firstLine(output);
    run.outputChars = output.length;
    run.detail = detailLines(output);
    run.live = undefined;
    entry.failed = isError;
    entry.text = toolRowText(run);
    this.notify();
  }
}

export function toolRowSpans(run: ToolRun): MarkdownSpan[] {
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

export function compactJson(value: unknown): string {
  const text = JSON.stringify(value) ?? "";
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

interface RunningTool {
  entry: ToolEntry;
  run: ToolRun;
  tail: TailFollow;
}

const streamSettleSteps = 4;
const liveLineLimit = 120;
const detailLineLimit = 12;

function toolRowText(run: ToolRun): string {
  return toolRowSpans(run)
    .map((span) => span.text)
    .join("");
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

function firstLine(output: string): string {
  const line = output.split("\n", 1)[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}
