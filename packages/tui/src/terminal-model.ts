import type { EngineEvents, ToolCallPart } from "@keywork/engine";
import { clamp } from "./clamp.ts";
import type { Chord } from "./keys.ts";
import type { TerminalMode } from "./pane.ts";
import { isPrintable } from "./picker-keys.ts";
import { take } from "./width.ts";

export type { TerminalMode } from "./pane.ts";

export interface TerminalChild {
  readonly shellName: string;
  write(text: string): void;
  onOutput(listener: (chunk: string) => void): () => void;
  onExit(listener: (code: number | null) => void): () => void;
  kill(): Promise<void> | void;
}

export type TerminalSpawner = (cwd: string) => TerminalChild;

export interface MirrorBus {
  on<K extends "tool.started" | "tool.output" | "tool.finished">(
    type: K,
    listener: (payload: EngineEvents[K]) => void,
  ): () => void;
}

export interface MirrorTarget {
  paneId?: string;
  sessionId?: string;
}

export interface MirrorSource {
  locate(target: MirrorTarget): { bus: MirrorBus; sessionId?: string } | undefined;
}

export type TerminalTone = "command" | "output" | "marker" | "failure" | "input";

export interface TerminalLine {
  text: string;
  tone: TerminalTone;
}

export interface TerminalModelOptions {
  mode: TerminalMode;
  notify: () => void;
  cwd?: string;
  spawn?: TerminalSpawner;
  mirror?: MirrorSource;
  target?: MirrorTarget;
  scrollbackLimit?: number;
}

export const scrollbackLineLimit = 2000;
export const mirroredToolNames: ReadonlySet<string> = new Set(["bash", "shell"]);

export class TerminalModel {
  readonly mode: TerminalMode;
  input = "";
  private readonly scrollback: TerminalScrollback;
  private readonly notify: () => void;
  private readonly cwd: string;
  private readonly spawn: TerminalSpawner | undefined;
  private readonly mirror: MirrorSource | undefined;
  private target: MirrorTarget;
  private child: TerminalChild | undefined;
  private childName: string | undefined;
  private releaseChild: () => void = () => {};
  private stopMirror: (() => void) | undefined;
  private readonly mirrored = new Map<string, number>();
  private disposed = false;

  constructor(options: TerminalModelOptions) {
    this.mode = options.mode;
    this.notify = options.notify;
    this.cwd = options.cwd ?? ".";
    this.spawn = options.spawn;
    this.mirror = options.mirror;
    this.target = options.target ?? {};
    this.scrollback = new TerminalScrollback(options.scrollbackLimit ?? scrollbackLineLimit);
    if (this.mode === "shell") this.startShell();
  }

  get sessionId(): string | undefined {
    return this.target.sessionId;
  }

  following(): boolean {
    return this.stopMirror !== undefined;
  }

  shellRunning(): boolean {
    return this.child !== undefined;
  }

  shellName(): string | undefined {
    return this.childName;
  }

  lineCount(): number {
    return this.scrollback.lineCount();
  }

  atEnd(): boolean {
    return this.scrollback.atEnd();
  }

  visibleLines(rows: number, width: number): TerminalLine[] {
    this.ensureFollowing();
    return this.scrollback.visible(rows, width);
  }

  status(): string {
    if (this.mode === "shell") return this.shellStatus();
    this.ensureFollowing();
    return this.stopMirror === undefined ? "waiting for a session to mirror" : "mirroring";
  }

  handleKey(chord: Chord, pageRows: number, sequence?: string): boolean {
    if (this.scrollKey(chord, pageRows)) return true;
    return this.mode === "shell" && this.inputKey(chord, sequence);
  }

  dispose(): void {
    this.disposed = true;
    this.stopMirror?.();
    this.stopMirror = undefined;
    this.killShell();
  }

  private ensureFollowing(): void {
    if (this.mode !== "mirror" || this.stopMirror !== undefined || this.mirror === undefined)
      return;
    const located = this.mirror.locate(this.target);
    if (located === undefined) return;
    if (located.sessionId !== undefined)
      this.target = { ...this.target, sessionId: located.sessionId };
    this.stopMirror = this.follow(located.bus);
  }

  private follow(bus: MirrorBus): () => void {
    const stops = [
      bus.on("tool.started", ({ call }) => this.mirrorStart(call)),
      bus.on("tool.output", ({ chunk, callId }) => this.mirrorOutput(chunk, callId)),
      bus.on("tool.finished", ({ callId, output, isError }) =>
        this.mirrorFinish(callId, output, isError),
      ),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }

  private mirrorStart(call: ToolCallPart): void {
    if (!mirroredToolNames.has(call.name)) return;
    this.mirrored.set(call.callId, 0);
    this.scrollback.push(`$ ${commandOf(call.arguments)}\n`, "command");
    this.notify();
  }

  private mirrorOutput(chunk: string, callId: string | undefined): void {
    const key = callId ?? this.onlyRunningCall();
    if (key === undefined || !this.mirrored.has(key)) return;
    this.mirrored.set(key, (this.mirrored.get(key) ?? 0) + chunk.length);
    this.scrollback.push(chunk, "output");
    this.notify();
  }

  private mirrorFinish(callId: string, output: string, isError: boolean): void {
    const streamed = this.mirrored.get(callId);
    if (streamed === undefined) return;
    this.mirrored.delete(callId);
    if (streamed === 0 && output !== "") this.scrollback.push(withNewline(output), "output");
    this.scrollback.push(isError ? "· failed\n" : "· done\n", isError ? "failure" : "marker");
    this.notify();
  }

  private onlyRunningCall(): string | undefined {
    const running = [...this.mirrored.keys()];
    return running.length === 1 ? running[0] : undefined;
  }

  private shellStatus(): string {
    if (this.child !== undefined) return `shell · ${this.childName ?? "shell"}`;
    return this.childName === undefined ? "no shell" : "shell exited · enter restarts it";
  }

  private startShell(): void {
    if (this.spawn === undefined || this.disposed) return;
    const child = this.spawn(this.cwd);
    this.child = child;
    this.childName = child.shellName;
    const stopOutput = child.onOutput((chunk) => {
      this.scrollback.push(chunk, "output");
      this.notify();
    });
    const stopExit = child.onExit((code) => {
      if (this.child !== child) return;
      this.releaseChild();
      this.child = undefined;
      this.scrollback.push(`· shell exited${code === null ? "" : ` (${code})`}\n`, "marker");
      this.notify();
    });
    this.releaseChild = () => {
      stopOutput();
      stopExit();
      this.releaseChild = () => {};
    };
  }

  private killShell(): void {
    const child = this.child;
    this.releaseChild();
    this.child = undefined;
    void child?.kill();
  }

  private inputKey(chord: Chord, sequence: string | undefined): boolean {
    if (chord.name === "return" || chord.name === "enter") {
      this.submitInput();
      return true;
    }
    if (chord.name === "backspace") {
      this.input = this.input.slice(0, -1);
      this.notify();
      return true;
    }
    if (!isPrintable(chord, sequence)) return false;
    this.input += sequence;
    this.notify();
    return true;
  }

  private submitInput(): void {
    const line = this.input;
    this.input = "";
    if (this.child === undefined) this.startShell();
    this.scrollback.push(`❯ ${line}\n`, "input");
    this.scrollback.scrollToEnd();
    this.child?.write(`${line}\n`);
    this.notify();
  }

  private scrollKey(chord: Chord, pageRows: number): boolean {
    const step = scrollStepOf(chord, pageRows, this.mode);
    if (step === undefined) return false;
    this.scrollback.scrollBy(step);
    this.notify();
    return true;
  }
}

export class TerminalScrollback {
  private readonly lines: TerminalLine[] = [];
  private open: TerminalLine | undefined;
  private offsetFromEnd = 0;
  private carriagePending = false;

  constructor(private readonly limit: number) {}

  push(chunk: string, tone: TerminalTone): void {
    for (const character of chunk.replace(ansiSequences, "")) this.absorb(character, tone);
  }

  lineCount(): number {
    return this.lines.length + (this.open === undefined ? 0 : 1);
  }

  atEnd(): boolean {
    return this.offsetFromEnd === 0;
  }

  scrollBy(delta: number): void {
    const room = Math.max(0, this.lineCount());
    this.offsetFromEnd = clamp(this.offsetFromEnd - delta, 0, room);
  }

  scrollToEnd(): void {
    this.offsetFromEnd = 0;
  }

  visible(rows: number, width: number): TerminalLine[] {
    const all = this.open === undefined ? this.lines : [...this.lines, this.open];
    const end = Math.max(Math.min(rows, all.length), all.length - this.offsetFromEnd);
    return all
      .slice(Math.max(0, end - rows), end)
      .map((line) => ({ tone: line.tone, text: take(line.text, Math.max(0, width)) }));
  }

  private absorb(character: string, tone: TerminalTone): void {
    const current = this.open ?? { text: "", tone };
    this.open = current;
    if (character === "\r") {
      this.carriagePending = true;
      return;
    }
    if (this.carriagePending && character !== "\n") current.text = "";
    this.carriagePending = false;
    if (character === "\n") {
      this.lines.push(current);
      this.open = undefined;
      this.trim();
      return;
    }
    if (isControl(character) || current.text.length >= storedLineLimit) return;
    current.text += character;
  }

  private trim(): void {
    const excess = this.lines.length - this.limit;
    if (excess <= 0) return;
    this.lines.splice(0, excess);
    this.offsetFromEnd = Math.min(this.offsetFromEnd, this.lines.length);
  }
}

const storedLineLimit = 1000;
const escapeChar = String.fromCharCode(27);
const bellChar = String.fromCharCode(7);
const ansiSequences = new RegExp(
  [
    `${escapeChar}\\][^${bellChar}${escapeChar}]*(?:${bellChar}|${escapeChar}\\\\)?`,
    `${escapeChar}\\[[0-9;?]*[ -/]*[@-~]`,
    `${escapeChar}.`,
  ].join("|"),
  "g",
);

function scrollStepOf(chord: Chord, pageRows: number, mode: TerminalMode): number | undefined {
  if (chord.ctrl || chord.meta) return undefined;
  const page = Math.max(1, pageRows);
  switch (chord.name) {
    case "pageup":
      return -page;
    case "pagedown":
      return page;
    case "home":
      return Number.NEGATIVE_INFINITY;
    case "end":
      return Number.POSITIVE_INFINITY;
  }
  if (mode === "shell") return undefined;
  switch (chord.name) {
    case "up":
    case "k":
      return -1;
    case "down":
    case "j":
      return 1;
    case "g":
      return chord.shift ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    default:
      return undefined;
  }
}

function commandOf(args: unknown): string {
  if (typeof args === "object" && args !== null && "command" in args) {
    const command = (args as { command: unknown }).command;
    if (typeof command === "string") return command;
  }
  return JSON.stringify(args);
}

function withNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function isControl(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code < 32 || code === 127;
}
