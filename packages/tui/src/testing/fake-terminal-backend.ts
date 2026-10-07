import { Text } from "@opentui/core";
import type { Chord } from "../keys.ts";
import type { PaneChild } from "../pane-chrome.ts";
import type { PtyBackend, TerminalProcess, TerminalSize } from "../terminal-backend.ts";
import type { TerminalSurface } from "../terminal-surface.ts";

export interface FakeProcess extends TerminalProcess {
  readonly cwd: string;
  readonly size: TerminalSize;
  readonly written: string[];
  readonly resizes: TerminalSize[];
  killed: number;
  emit(text: string): void;
  exit(code: number | null): void;
}

export interface FakeSurface extends TerminalSurface {
  readonly fed: string[];
  readonly resizes: TerminalSize[];
  readonly focus: boolean[];
  released: number;
  reply(text: string): void;
}

export interface FakeBackend extends PtyBackend {
  readonly processes: FakeProcess[];
  readonly surfaces: FakeSurface[];
  failNextOpen(message: string): void;
}

export function fakePtyBackend(shellName = "fakesh"): FakeBackend {
  const processes: FakeProcess[] = [];
  const surfaces: FakeSurface[] = [];
  let failure: string | undefined;
  return {
    kind: "pty",
    processes,
    surfaces,
    failNextOpen: (message) => {
      failure = message;
    },
    open: (cwd, size) => {
      if (failure !== undefined) {
        const message = failure;
        failure = undefined;
        throw new Error(message);
      }
      const process = fakeProcess(cwd, size, shellName);
      processes.push(process);
      return process;
    },
    surface: (size) => {
      const surface = fakeSurface(size);
      surfaces.push(surface);
      return surface;
    },
  };
}

export function fakeProcess(
  cwd: string,
  size: TerminalSize = { cols: 80, rows: 24 },
  shellName = "fakesh",
): FakeProcess {
  const outputs = new Set<(bytes: Uint8Array) => void>();
  const exits = new Set<(code: number | null) => void>();
  return {
    cwd,
    size,
    shellName,
    pid: 4242,
    written: [],
    resizes: [],
    killed: 0,
    write(data) {
      this.written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    },
    resize(size) {
      this.resizes.push(size);
    },
    onOutput: (listener) => {
      outputs.add(listener);
      return () => outputs.delete(listener);
    },
    onExit: (listener) => {
      exits.add(listener);
      return () => exits.delete(listener);
    },
    kill() {
      this.killed += 1;
      return Promise.resolve();
    },
    emit: (text) => {
      for (const listener of outputs) listener(new TextEncoder().encode(text));
    },
    exit: (code) => {
      for (const listener of exits) listener(code);
    },
  };
}

export function fakeSurface(size: TerminalSize): FakeSurface {
  const replies = new Set<(bytes: Uint8Array) => void>();
  return {
    fed: [],
    resizes: [size],
    focus: [],
    released: 0,
    feed(bytes) {
      this.fed.push(new TextDecoder().decode(bytes));
    },
    encodeKey: (chord, sequence) => new TextEncoder().encode(encodedKey(chord, sequence)),
    encodePaste: (text) => new TextEncoder().encode(`[paste:${text}]`),
    resize(next) {
      this.resizes.push(next);
    },
    setFocused(focused) {
      this.focus.push(focused);
    },
    onReply: (listener) => {
      replies.add(listener);
      return () => replies.delete(listener);
    },
    view: (): PaneChild => Text({ content: "<terminal surface>" }),
    release() {
      this.released += 1;
    },
    reply: (text) => {
      for (const listener of replies) listener(new TextEncoder().encode(text));
    },
  };
}

export function encodedKey(chord: Chord, sequence: string | undefined): string {
  const modifiers = [chord.ctrl && "ctrl", chord.shift && "shift", chord.meta && "meta"]
    .filter((part): part is string => typeof part === "string")
    .join("+");
  const body = sequence !== undefined && sequence !== "" ? sequence : chord.name;
  return modifiers === "" ? `<${body}>` : `<${modifiers}+${body}>`;
}
