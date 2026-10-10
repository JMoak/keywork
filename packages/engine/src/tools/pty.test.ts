import { describe, expect, it } from "vitest";
import {
  type BunPtyRuntime,
  type BunPtySpawnOptions,
  type BunPtySubprocess,
  type BunTerminal,
  type BunTerminalOptions,
  interactiveShell,
  probePtySupport,
  ptyUnavailableInRuntime,
  ptyUnavailableOnWindows,
} from "./pty.ts";

interface FakeTerminal extends BunTerminal {
  readonly options: BunTerminalOptions;
  readonly writes: string[];
  readonly sizes: [number, number][];
  closes: number;
}

interface FakeSubprocess extends BunPtySubprocess {
  readonly command: string[];
  readonly options: BunPtySpawnOptions;
  readonly signals: string[];
  finish(code: number): void;
}

function fakeRuntime() {
  const terminals: FakeTerminal[] = [];
  const children: FakeSubprocess[] = [];
  const runtime: BunPtyRuntime = {
    Terminal: class implements FakeTerminal {
      readonly writes: string[] = [];
      readonly sizes: [number, number][] = [];
      closes = 0;
      constructor(readonly options: BunTerminalOptions) {
        terminals.push(this);
      }
      get closed(): boolean {
        return this.closes > 0;
      }
      write(data: string | Uint8Array): number {
        const text = typeof data === "string" ? data : new TextDecoder().decode(data);
        this.writes.push(text);
        return text.length;
      }
      resize(cols: number, rows: number): void {
        this.sizes.push([cols, rows]);
      }
      close(): void {
        this.closes += 1;
      }
    },
    spawn: (command, options) => {
      let settle: (code: number) => void = () => {};
      const exited = new Promise<number>((resolvePromise) => {
        settle = resolvePromise;
      });
      const child: FakeSubprocess = {
        command,
        options,
        signals: [],
        pid: 777,
        exited,
        exitCode: null,
        signalCode: null,
        kill(signal) {
          this.signals.push(String(signal));
        },
        finish: (code) => settle(code),
      };
      children.push(child);
      return child;
    },
  };
  return { runtime, terminals, children };
}

function last<T>(items: readonly T[]): T {
  const item = items.at(-1);
  if (item === undefined) throw new Error("expected an item");
  return item;
}

const flush = (): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

describe("probePtySupport", () => {
  it("refuses Windows with Bun's own POSIX-only reason, whatever the runtime offers", () => {
    const { runtime } = fakeRuntime();
    expect(probePtySupport({ platform: "win32", runtime })).toEqual({
      available: false,
      reason: ptyUnavailableOnWindows,
    });
  });

  it("refuses a runtime without Bun.Terminal (Node, or a Bun before 1.3.14)", () => {
    expect(probePtySupport({ platform: "linux", runtime: undefined })).toEqual({
      available: false,
      reason: ptyUnavailableInRuntime,
    });
  });

  it("offers an opener on POSIX with a Bun that has Bun.Terminal, after opening and closing one", () => {
    const { runtime, terminals } = fakeRuntime();
    expect(probePtySupport({ platform: "linux", runtime }).available).toBe(true);
    expect(terminals).toHaveLength(1);
    expect(last(terminals).closes).toBe(1);
  });

  it("degrades to pipes with the constructor's message when Bun.Terminal refuses to open", () => {
    const { runtime } = fakeRuntime();
    const refusing: BunPtyRuntime = {
      ...runtime,
      Terminal: class {
        constructor() {
          throw new Error("PTY not supported on this platform");
        }
      } as unknown as BunPtyRuntime["Terminal"],
    };
    expect(probePtySupport({ platform: "linux", runtime: refusing })).toEqual({
      available: false,
      reason:
        "Bun.Terminal refused to open (PTY not supported on this platform); running the pipe shell",
    });
  });
});

describe("interactiveShell", () => {
  it("prefers the login shell on POSIX and names it by basename", () => {
    expect(interactiveShell({ platform: "linux", loginShell: "/usr/bin/zsh" })).toMatchObject({
      file: "/usr/bin/zsh",
      name: "zsh",
    });
  });

  it("falls back to the detected shell when SHELL is unset or on Windows", () => {
    expect(interactiveShell({ platform: "linux", loginShell: undefined }).file).toBe("/bin/sh");
    expect(interactiveShell({ platform: "win32", loginShell: "/bin/zsh" }).file).not.toBe(
      "/bin/zsh",
    );
  });
});

describe("the pty child over Bun.Terminal", () => {
  function open(size = { cols: 100, rows: 30 }) {
    const fake = fakeRuntime();
    const support = probePtySupport(
      { platform: "linux", runtime: fake.runtime },
      { file: "/bin/bash", args: () => [], name: "bash" },
    );
    if (!support.available) throw new Error(support.reason);
    const child = support.open("/repo", size);
    return { ...fake, child };
  }

  it("spawns an interactive login-style shell on a terminal of the requested size with TERM set", () => {
    const { child, terminals, children } = open();
    expect(child.shellName).toBe("bash");
    expect(child.pid).toBe(777);
    expect(last(terminals).options).toMatchObject({ cols: 100, rows: 30, name: "xterm-256color" });
    expect(last(children).command).toEqual(["/bin/bash", "-i"]);
    expect(last(children).options.cwd).toBe("/repo");
    expect(last(children).options.env.TERM).toBe("xterm-256color");
    expect(last(children).options.terminal).toBe(last(terminals));
  });

  it("scrubs API keys and keywork's own variables from the child's environment", () => {
    process.env.PTYTEST_API_KEY = "secret";
    process.env.KEYWORK_PTYTEST = "secret";
    try {
      const { children } = open();
      expect(last(children).options.env.PTYTEST_API_KEY).toBeUndefined();
      expect(last(children).options.env.KEYWORK_PTYTEST).toBeUndefined();
    } finally {
      delete process.env.PTYTEST_API_KEY;
      delete process.env.KEYWORK_PTYTEST;
    }
  });

  it("delivers terminal data to output listeners and writes and resizes through the terminal", () => {
    const { child, terminals } = open();
    const seen: string[] = [];
    const stop = child.onOutput((bytes) => seen.push(new TextDecoder().decode(bytes)));
    const terminal = last(terminals);
    terminal.options.data?.(terminal, new TextEncoder().encode("$ "));
    child.write("ls\n");
    child.resize({ cols: 40, rows: 10 });
    stop();
    terminal.options.data?.(terminal, new TextEncoder().encode("unseen"));
    expect(seen).toEqual(["$ "]);
    expect(terminal.writes).toEqual(["ls\n"]);
    expect(terminal.sizes).toEqual([[40, 10]]);
  });

  it("closes the terminal and announces the exit code when the child exits on its own", async () => {
    const { child, terminals, children } = open();
    const codes: (number | null)[] = [];
    child.onExit((code) => codes.push(code));
    last(children).finish(3);
    await flush();
    expect(codes).toEqual([3]);
    expect(last(terminals).closes).toBe(1);
    child.write("after");
    expect(last(terminals).writes).toEqual([]);
  });

  it("kills by closing the pty, hanging up, and waiting for the exit", async () => {
    const { child, terminals, children } = open();
    const killed = child.kill();
    expect(last(terminals).closes).toBe(1);
    expect(last(children).signals).toEqual(["SIGHUP"]);
    last(children).finish(129);
    await killed;
    expect(last(children).signals).toEqual(["SIGHUP"]);
  });
});
