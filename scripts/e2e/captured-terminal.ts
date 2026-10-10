import { Readable, Writable } from "node:stream";
import type { AppOptions } from "../../packages/tui/src/index.ts";
import type { FrameSize } from "./scenario.ts";

export type TerminalSeams = NonNullable<AppOptions["terminal"]>;

export interface CapturedTerminal {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  readonly seams: TerminalSeams;
  bytes(): string;
  answer(reply: string): void;
}

export const kittyKeyboardReply = "\x1b[?1u";

export function capturedTerminal(size: FrameSize): CapturedTerminal {
  const stdin = new Readable({ read() {} });
  const stdout = new TerminalRecorder(size);
  return {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    seams: {
      write: (bytes) => void stdout.write(bytes),
      facts: { tty: true, env: { TERM: "xterm-256color" } },
      input: (listener) => {
        const onData = (chunk: Buffer | string): void => listener(chunk.toString());
        stdin.on("data", onData);
        return () => void stdin.off("data", onData);
      },
    },
    bytes: () => stdout.recorded,
    answer: (reply) => void stdin.push(reply),
  };
}

class TerminalRecorder extends Writable {
  readonly isTTY = true;
  readonly columns: number;
  readonly rows: number;
  recorded = "";

  constructor(size: FrameSize) {
    super();
    this.columns = size.width;
    this.rows = size.height;
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, done: () => void): void {
    this.recorded += chunk.toString();
    done();
  }

  getColorDepth(): number {
    return 24;
  }
}
