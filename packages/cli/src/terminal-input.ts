import { createInterface, emitKeypressEvents, type Interface } from "node:readline";
import type { Confirm } from "./command-io.ts";

export type InputStream = NodeJS.ReadableStream & {
  isTTY?: boolean | undefined;
  isRaw?: boolean | undefined;
  setRawMode?(raw: boolean): unknown;
};

export type OutputStream = NodeJS.WritableStream & { isTTY?: boolean | undefined };

export interface TerminalStreams {
  input: InputStream;
  output: OutputStream;
}

export type Completer = (line: string) => [string[], string];

export interface LineReadOptions {
  complete?: Completer | undefined;
}

export interface KeyPress {
  name: string | undefined;
  ctrl: boolean;
  sequence: string;
}

export interface TerminalInput {
  readonly interactive: boolean;
  readLine(prompt: string, options?: LineReadOptions): Promise<string | undefined>;
  readSecret(prompt: string): Promise<string>;
  confirm(question: string): Promise<boolean>;
  readKey(): Promise<KeyPress | undefined>;
  onKey(listener: (key: KeyPress) => void): () => void;
  close(): void;
}

export function processStreams(): TerminalStreams {
  return { input: process.stdin, output: process.stdout };
}

export function isInteractive(streams: TerminalStreams): boolean {
  return streams.input.isTTY === true && streams.output.isTTY === true;
}

export function terminalInput(streams: TerminalStreams = processStreams()): TerminalInput {
  return isInteractive(streams) ? interactiveInput(streams) : pipedInput(streams);
}

export function terminalConfirm(streams: TerminalStreams = processStreams()): Confirm | undefined {
  if (!isInteractive(streams)) return undefined;
  const terminal = interactiveInput(streams);
  return (question) => terminal.confirm(question);
}

export function saidYes(answer: string | undefined): boolean {
  return answer?.trim().toLowerCase().startsWith("y") === true;
}

function interactiveInput(streams: TerminalStreams): TerminalInput {
  const { input, output } = streams;
  let history: string[] = [];
  const keys = keyMode(input);
  const readLine = (prompt: string, options: LineReadOptions = {}): Promise<string | undefined> =>
    new Promise((resolve) => {
      const editor = createInterface({
        input,
        output,
        terminal: true,
        history: [...history],
        ...(options.complete !== undefined && { completer: options.complete }),
      });
      editor.on("history", (lines) => {
        history = [...lines];
      });
      editor.on("line", (line) => {
        resolve(line);
        editor.close();
      });
      editor.on("close", () => resolve(undefined));
      editor.setPrompt(prompt);
      editor.prompt();
    });
  return {
    interactive: true,
    readLine,
    readSecret: (prompt) => readMaskedLine(prompt, input, output),
    confirm: async (question) => saidYes(await readLine(question)),
    readKey: () =>
      new Promise((resolve) => {
        const release = keys.acquire();
        const settle = (key: KeyPress | undefined): void => {
          input.off("keypress", onKeypress);
          input.off("end", onEnd);
          release();
          resolve(key);
        };
        const onKeypress = (_chunk: unknown, key: RawKey | undefined): void =>
          settle(keyPressOf(key));
        const onEnd = (): void => settle(undefined);
        input.on("keypress", onKeypress);
        input.once("end", onEnd);
      }),
    onKey: (listener) => {
      const release = keys.acquire();
      const onKeypress = (_chunk: unknown, key: RawKey | undefined): void =>
        listener(keyPressOf(key));
      input.on("keypress", onKeypress);
      return () => {
        input.off("keypress", onKeypress);
        release();
      };
    },
    close: () => {},
  };
}

function pipedInput(streams: TerminalStreams): TerminalInput {
  const lines = lineQueue(streams.input);
  const readLine = (prompt: string): Promise<string | undefined> => {
    streams.output.write(prompt);
    return lines.next();
  };
  return {
    interactive: false,
    readLine,
    readSecret: async (prompt) => (await readLine(prompt)) ?? "",
    confirm: async (question) => saidYes(await readLine(question)),
    readKey: () => Promise.resolve(undefined),
    onKey: () => () => {},
    close: () => lines.close(),
  };
}

interface LineQueue {
  next(): Promise<string | undefined>;
  close(): void;
}

function lineQueue(input: InputStream): LineQueue {
  const buffered: string[] = [];
  const waiting: ((line: string | undefined) => void)[] = [];
  let ended = false;
  let reader: Interface | undefined;
  const open = (): void => {
    if (reader !== undefined || ended) return;
    reader = createInterface({ input, terminal: false });
    reader.on("line", (line) => {
      const waiter = waiting.shift();
      if (waiter === undefined) buffered.push(line);
      else waiter(line);
    });
    reader.on("close", () => {
      ended = true;
      for (const waiter of waiting.splice(0)) waiter(undefined);
    });
  };
  return {
    next: () => {
      open();
      const line = buffered.shift();
      if (line !== undefined) return Promise.resolve(line);
      if (ended) return Promise.resolve(undefined);
      return new Promise((resolve) => waiting.push(resolve));
    },
    close: () => reader?.close(),
  };
}

interface RawKey {
  name?: string | undefined;
  ctrl?: boolean | undefined;
  sequence?: string | undefined;
}

function keyPressOf(key: RawKey | undefined): KeyPress {
  return { name: key?.name, ctrl: key?.ctrl === true, sequence: key?.sequence ?? "" };
}

interface KeyMode {
  acquire(): () => void;
}

function keyMode(input: InputStream): KeyMode {
  let holders = 0;
  let wasRaw = false;
  return {
    acquire: () => {
      if (holders === 0) {
        emitKeypressEvents(input);
        wasRaw = input.isRaw === true;
        input.setRawMode?.(true);
        input.resume();
      }
      holders += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holders -= 1;
        if (holders > 0) return;
        input.setRawMode?.(wasRaw);
        input.pause();
      };
    },
  };
}

const enter = new Set(["\r", "\n"]);
const erase = new Set([String.fromCharCode(127), "\b"]);
const interruptKey = String.fromCharCode(3);

function readMaskedLine(prompt: string, input: InputStream, output: OutputStream): Promise<string> {
  output.write(prompt);
  const wasRaw = input.isRaw ?? false;
  if (input.isTTY) input.setRawMode?.(true);
  input.resume();
  return new Promise((resolve) => {
    let entered = "";
    const finish = (): void => {
      input.off("data", onData);
      if (input.isTTY) input.setRawMode?.(wasRaw);
      input.pause();
      output.write("\n");
      resolve(entered);
    };
    const onData = (chunk: Buffer | string): void => {
      for (const char of chunk.toString()) {
        if (char === interruptKey) entered = "";
        if (enter.has(char) || char === interruptKey) {
          finish();
          return;
        }
        if (erase.has(char)) {
          if (entered.length > 0) {
            entered = entered.slice(0, -1);
            output.write("\b \b");
          }
          continue;
        }
        if (char < " ") continue;
        entered += char;
        output.write("*");
      }
    };
    input.on("data", onData);
  });
}
