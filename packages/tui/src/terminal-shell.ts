import type { Chord } from "./keys.ts";
import type { PaneChild } from "./pane-chrome.ts";
import type { PtyBackend, TerminalProcess, TerminalSize } from "./terminal-backend.ts";
import type { TerminalSurface } from "./terminal-surface.ts";

export interface PtyShellOptions {
  cwd: string;
  backend: PtyBackend;
  notify: () => void;
  size?: TerminalSize;
}

export const defaultTerminalSize: TerminalSize = { cols: 80, rows: 24 };

export class PtyShell {
  private readonly surface: TerminalSurface;
  private readonly cwd: string;
  private readonly backend: PtyBackend;
  private readonly notify: () => void;
  private size: TerminalSize;
  private process: TerminalProcess | undefined;
  private releaseProcess: () => void = () => {};
  private label: string | undefined;
  private failure: string | undefined;
  private disposed = false;

  constructor(options: PtyShellOptions) {
    this.cwd = options.cwd;
    this.backend = options.backend;
    this.notify = options.notify;
    this.size = options.size ?? defaultTerminalSize;
    this.surface = options.backend.surface(this.size);
    this.surface.onReply((bytes) => this.process?.write(bytes));
    this.start();
  }

  running(): boolean {
    return this.process !== undefined;
  }

  shellName(): string | undefined {
    return this.label;
  }

  status(): string {
    if (this.process !== undefined) return `shell · ${this.label ?? "shell"}`;
    if (this.failure !== undefined) return "shell failed · enter retries";
    return "shell exited · enter restarts it";
  }

  view(): PaneChild {
    return this.surface.view();
  }

  resize(size: TerminalSize): void {
    if (size.cols === this.size.cols && size.rows === this.size.rows) return;
    this.size = size;
    this.surface.resize(size);
    this.process?.resize(size);
  }

  focusChanged(focused: boolean): void {
    this.surface.setFocused(focused);
  }

  handleKey(chord: Chord, sequence: string | undefined): boolean {
    if (this.process === undefined) return this.restartOn(chord);
    const bytes = this.surface.encodeKey(chord, sequence);
    if (bytes.byteLength === 0) return false;
    this.process.write(bytes);
    return true;
  }

  handlePaste(text: string): boolean {
    if (this.process === undefined) return false;
    this.process.write(this.surface.encodePaste(text));
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.killProcess();
    this.surface.release();
  }

  private restartOn(chord: Chord): boolean {
    if (chord.name !== "return" && chord.name !== "enter") return false;
    this.start();
    return true;
  }

  private start(): void {
    if (this.disposed) return;
    this.failure = undefined;
    const process = this.openProcess();
    if (process === undefined) return;
    this.process = process;
    this.label = process.shellName;
    const stopOutput = process.onOutput((bytes) => {
      this.surface.feed(bytes);
      this.notify();
    });
    const stopExit = process.onExit((code) => {
      if (this.process !== process) return;
      this.releaseProcess();
      this.process = undefined;
      this.announce(`shell exited${code === null ? "" : ` (${code})`} · enter restarts it`);
    });
    this.releaseProcess = () => {
      stopOutput();
      stopExit();
      this.releaseProcess = () => {};
    };
    this.notify();
  }

  private openProcess(): TerminalProcess | undefined {
    try {
      return this.backend.open(this.cwd, this.size);
    } catch (cause) {
      this.failure = cause instanceof Error ? cause.message : String(cause);
      this.announce(`shell failed to start: ${this.failure} · enter retries`);
      return undefined;
    }
  }

  private announce(text: string): void {
    this.surface.feed(new TextEncoder().encode(`\r\n· ${text}\r\n`));
    this.notify();
  }

  private killProcess(): void {
    const process = this.process;
    this.releaseProcess();
    this.process = undefined;
    void process?.kill().catch(() => undefined);
  }
}
