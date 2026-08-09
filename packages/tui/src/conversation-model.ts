import type { Agent, Message } from "@keywork/engine";
import type { Chord } from "./keys.ts";

export type Titler = (conversation: readonly Message[]) => Promise<string | undefined>;

export type TranscriptEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; text: string; failed: boolean }
  | { kind: "error"; text: string }
  | { kind: "info"; text: string };

export class ConversationModel {
  readonly entries: TranscriptEntry[] = [];
  input = "";
  busy = false;
  title: string | undefined;
  lastSend: Promise<unknown> = Promise.resolve();
  lastTitle: Promise<unknown> = Promise.resolve();
  private titleRequested = false;

  constructor(
    private readonly agent: Agent | undefined,
    private readonly notify: () => void,
    private readonly titler?: Titler,
  ) {
    if (agent === undefined) {
      this.entries.push({
        kind: "info",
        text: "no provider configured — set KEYWORK_OPENROUTER_API_KEY and relaunch",
      });
      return;
    }
    agent.bus.on("turn.delta", ({ delta }) => {
      if (delta.type !== "text") return;
      this.appendAssistant(delta.text);
      notify();
    });
    agent.bus.on("tool.started", ({ call }) => {
      this.entries.push({
        kind: "tool",
        text: `· ${call.name} ${compactJson(call.arguments)}`,
        failed: false,
      });
      notify();
    });
    agent.bus.on("tool.finished", ({ output, isError }) => {
      this.entries.push({
        kind: "tool",
        text: `${isError ? "✗" : "✓"} ${firstLine(output)}`,
        failed: isError,
      });
      notify();
    });
    agent.bus.on("turn.completed", () => {
      this.busy = false;
      this.requestTitleOnce();
      notify();
    });
    agent.bus.on("turn.interrupted", () => {
      this.busy = false;
      this.entries.push({ kind: "info", text: "— interrupted" });
      notify();
    });
  }

  usageSummary(): string {
    if (this.agent === undefined) return "";
    const { inputTokens, outputTokens } = this.agent.usage();
    return inputTokens + outputTokens === 0 ? "" : `${inputTokens}▸${outputTokens}`;
  }

  handleKey(chord: Chord, sequence: string | undefined): boolean {
    if (chord.name === "escape") {
      if (!this.busy) return false;
      this.agent?.interrupt();
      return true;
    }
    if (chord.name === "return" || chord.name === "enter") {
      this.submit();
      return true;
    }
    if (chord.name === "backspace") {
      this.input = this.input.slice(0, -1);
      this.notify();
      return true;
    }
    if (isPrintable(chord, sequence)) {
      this.input += sequence;
      this.notify();
      return true;
    }
    return false;
  }

  submit(): void {
    const text = this.input.trim();
    if (text === "" || this.busy || this.agent === undefined) return;
    this.input = "";
    this.entries.push({ kind: "user", text });
    this.busy = true;
    this.lastSend = this.agent.send(text).catch((cause: unknown) => {
      this.busy = false;
      this.entries.push({ kind: "error", text: (cause as Error).message });
      this.notify();
    });
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
  kind: TranscriptEntry["kind"];
  failed: boolean;
  text: string;
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
  const pieces: string[] = [];
  for (let at = 0; at < line.length; at += width) {
    pieces.push(line.slice(at, at + width));
  }
  return pieces;
}

function isPrintable(chord: Chord, sequence: string | undefined): boolean {
  if (sequence === undefined || sequence.length !== 1 || chord.ctrl || chord.meta) return false;
  const code = sequence.charCodeAt(0);
  return code >= 32 && code !== 127;
}

function compactJson(value: unknown): string {
  const text = JSON.stringify(value) ?? "";
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function firstLine(output: string): string {
  const line = output.split("\n", 1)[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}
