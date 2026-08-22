import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  isInteractive,
  type KeyPress,
  saidYes,
  type TerminalInput,
  type TerminalStreams,
  terminalConfirm,
  terminalInput,
} from "./terminal-input.ts";

class FakeTty extends PassThrough {
  isTTY = true;
  isRaw = false;
  rawModeChanges: boolean[] = [];

  setRawMode(raw: boolean): this {
    this.rawModeChanges.push(raw);
    this.isRaw = raw;
    return this;
  }
}

interface Harness {
  input: PassThrough;
  written: () => string;
  terminal: TerminalInput;
  streams: TerminalStreams;
}

function piped(): Harness {
  return harnessOf(new PassThrough(), new PassThrough());
}

function interactive(): Harness & { input: FakeTty } {
  const input = new FakeTty();
  return { ...harnessOf(input, new FakeTty()), input };
}

function harnessOf(input: PassThrough, output: PassThrough): Harness {
  const chunks: string[] = [];
  output.on("data", (chunk: Buffer | string) => chunks.push(chunk.toString()));
  const streams = { input, output };
  return { input, written: () => chunks.join(""), terminal: terminalInput(streams), streams };
}

const escapeKey = "\u001b";
const up = `${escapeKey}[A`;
const enter = "\r";
const controlD = "\u0004";
const controlC = "\u0003";

describe("terminalInput without a terminal", () => {
  it("reads answers line by line from piped stdin, even when they arrive in one chunk", async () => {
    const { input, terminal, written } = piped();
    input.write("1\nlab\nhttp://localhost:9/v1\n");

    expect(await terminal.readLine("Choice [1]: ")).toBe("1");
    expect(await terminal.readLine("Name: ")).toBe("lab");
    expect(await terminal.readLine("Endpoint: ")).toBe("http://localhost:9/v1");
    expect(written()).toBe("Choice [1]: Name: Endpoint: ");
    terminal.close();
  });

  it("waits for lines that have not arrived yet and reports the end of input as undefined", async () => {
    const { input, terminal } = piped();
    const pending = terminal.readLine("> ");
    input.write("later\n");
    expect(await pending).toBe("later");

    input.end();
    expect(await terminal.readLine("> ")).toBeUndefined();
    expect(await terminal.readLine("> ")).toBeUndefined();
  });

  it("reads a secret as the next plain line and answers confirmations from stdin", async () => {
    const { input, terminal, written } = piped();
    input.write("sk-piped\ny\nno\n");

    expect(await terminal.readSecret("key: ")).toBe("sk-piped");
    expect(await terminal.confirm("sure? ")).toBe(true);
    expect(await terminal.confirm("sure? ")).toBe(false);
    expect(written()).not.toContain("*");
    terminal.close();
  });

  it("has no keys to read", async () => {
    const { terminal } = piped();
    expect(terminal.interactive).toBe(false);
    expect(await terminal.readKey()).toBeUndefined();
    const stop = terminal.onKey(() => {
      throw new Error("never called");
    });
    stop();
    terminal.close();
  });

  it("treats an empty secret at end of input as a blank entry", async () => {
    const { input, terminal } = piped();
    input.end();
    expect(await terminal.readSecret("key: ")).toBe("");
  });
});

describe("terminalInput on a terminal", () => {
  it("reads an edited line and closes the editor after each answer", async () => {
    const { input, terminal, written } = interactive();
    const pending = terminal.readLine("› ");
    input.write(`hello${enter}`);

    expect(await pending).toBe("hello");
    expect(written()).toContain("› ");
    expect(input.rawModeChanges.at(-1)).toBe(false);
  });

  it("carries line history across reads so the up arrow recalls the last answer", async () => {
    const { input, terminal } = interactive();
    const first = terminal.readLine("› ");
    input.write(`first prompt${enter}`);
    await first;

    const second = terminal.readLine("› ");
    input.write(up);
    input.write(enter);

    expect(await second).toBe("first prompt");
  });

  it("resolves undefined when the reader closes on ctrl-d", async () => {
    const { input, terminal } = interactive();
    const pending = terminal.readLine("› ");
    input.write(controlD);

    expect(await pending).toBeUndefined();
  });

  it("masks a secret keystroke by keystroke and never echoes the key itself", async () => {
    const { input, terminal, written } = interactive();
    const pending = terminal.readSecret("key: ");
    for (const char of "sk-abc") input.write(char);
    input.write(enter);

    expect(await pending).toBe("sk-abc");
    expect(written()).not.toContain("sk-abc");
    expect(written()).toContain("*".repeat(6));
  });

  it("accepts a whole pasted secret in one chunk", async () => {
    const { input, terminal, written } = interactive();
    const pending = terminal.readSecret("key: ");
    input.write("sk-or-pasted-key\n");

    expect(await pending).toBe("sk-or-pasted-key");
    expect(written()).toContain("*".repeat("sk-or-pasted-key".length));
  });

  it("backspace erases the last secret character and ctrl-c abandons the entry", async () => {
    const { input, terminal } = interactive();
    const edited = terminal.readSecret("key: ");
    input.write("abcd");
    input.write(String.fromCharCode(127));
    input.write(enter);
    expect(await edited).toBe("abc");

    const abandoned = terminal.readSecret("key: ");
    input.write("secret");
    input.write(String.fromCharCode(3));
    expect(await abandoned).toBe("");
  });

  it("enables raw mode for a secret read and restores it after", async () => {
    const { input, terminal } = interactive();
    const pending = terminal.readSecret("key: ");
    input.write(`k${enter}`);
    await pending;

    expect(input.rawModeChanges).toEqual([true, false]);
  });

  it("reads one key in raw mode and restores the terminal afterwards", async () => {
    const { input, terminal } = interactive();
    const pending = terminal.readKey();
    input.write("y");

    expect(await pending).toMatchObject({ name: "y", ctrl: false });
    expect(input.rawModeChanges).toEqual([true, false]);
  });

  it("streams keys to a listener until it is stopped", async () => {
    const { input, terminal } = interactive();
    const seen: KeyPress[] = [];
    const stop = terminal.onKey((key) => seen.push(key));
    input.write(controlC);
    await flushKeypresses();
    stop();
    input.write("x");
    await flushKeypresses();

    expect(seen).toEqual([{ name: "c", ctrl: true, sequence: controlC }]);
    expect(input.rawModeChanges).toEqual([true, false]);
  });

  it("keeps raw mode while any key reader is active and leaves it when the last one stops", async () => {
    const { input, terminal } = interactive();
    const stop = terminal.onKey(() => {});
    const pending = terminal.readKey();
    input.write("a");
    await pending;
    expect(input.isRaw).toBe(true);

    stop();
    expect(input.isRaw).toBe(false);
    expect(input.rawModeChanges).toEqual([true, false]);
  });

  it("answers confirmations from the edited line", async () => {
    const { input, terminal } = interactive();
    const pending = terminal.confirm("delete it? [y/N] ");
    input.write(`Yes${enter}`);

    expect(await pending).toBe(true);
  });
});

describe("terminalConfirm", () => {
  it("is absent without a terminal so callers skip the question instead of assuming", () => {
    expect(terminalConfirm(piped().streams)).toBeUndefined();
    expect(terminalConfirm({ input: new FakeTty(), output: new PassThrough() })).toBeUndefined();
  });

  it("asks on the terminal and reads a y/N answer", async () => {
    const { input, streams } = interactive();
    const confirm = terminalConfirm(streams);
    const pending = confirm?.("sure? [y/N] ");
    input.write(`n${enter}`);

    expect(await pending).toBe(false);
  });
});

describe("isInteractive and saidYes", () => {
  it("needs both streams to be terminals", () => {
    expect(isInteractive(interactive().streams)).toBe(true);
    expect(isInteractive(piped().streams)).toBe(false);
  });

  it("reads any y-prefixed answer as yes", () => {
    expect(saidYes("y")).toBe(true);
    expect(saidYes(" YES ")).toBe(true);
    expect(saidYes("n")).toBe(false);
    expect(saidYes("")).toBe(false);
    expect(saidYes(undefined)).toBe(false);
  });
});

function flushKeypresses(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
