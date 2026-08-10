import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readMaskedLine, saveApiKey } from "./setup.ts";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-setup-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class FakeTty extends EventEmitter {
  isTTY = true;
  isRaw = false;
  rawModeChanges: boolean[] = [];

  setRawMode(raw: boolean): void {
    this.rawModeChanges.push(raw);
    this.isRaw = raw;
  }

  resume(): void {}
  pause(): void {}

  type(text: string): void {
    this.emit("data", text);
  }
}

function maskedRead(prompt = "key: "): {
  input: FakeTty;
  written: string[];
  line: Promise<string>;
} {
  const input = new FakeTty();
  const written: string[] = [];
  const line = readMaskedLine(prompt, input, { write: (text) => written.push(text) });
  return { input, written, line };
}

describe("readMaskedLine", () => {
  it("echoes a mask per keystroke and never the key itself", async () => {
    const { input, written, line } = maskedRead();

    for (const char of "sk-abc") input.type(char);
    input.type("\r");

    expect(await line).toBe("sk-abc");
    const echoed = written.join("");
    expect(echoed).not.toContain("sk-abc");
    expect(echoed).toContain("*".repeat(6));
  });

  it("accepts a whole pasted key in one chunk", async () => {
    const { input, written, line } = maskedRead();

    input.type("sk-or-pasted-key\n");

    expect(await line).toBe("sk-or-pasted-key");
    expect(written.join("")).toContain("*".repeat("sk-or-pasted-key".length));
  });

  it("backspace erases the last character", async () => {
    const { input, line } = maskedRead();

    input.type("abcd");
    input.type(String.fromCharCode(127));
    input.type("\r");

    expect(await line).toBe("abc");
  });

  it("ctrl-c abandons the entry", async () => {
    const { input, line } = maskedRead();

    input.type("secret");
    input.type(String.fromCharCode(3));

    expect(await line).toBe("");
  });

  it("enables raw mode for the read and restores it after", async () => {
    const { input, line } = maskedRead();

    input.type("k\r");
    await line;

    expect(input.rawModeChanges).toEqual([true, false]);
  });
});

describe("saveApiKey", () => {
  async function savedConfig(dir: string): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(join(dir, "keywork.json"), "utf8"));
  }

  it("writes the key under the provider name", async () => {
    const dir = await tempDir();

    await saveApiKey("openrouter", "sk-or-new", dir);

    expect(await savedConfig(dir)).toEqual({ apiKeys: { openrouter: "sk-or-new" } });
  });

  it("keeps schema-known fields and drops unknown ones", async () => {
    const dir = await tempDir();
    const poisoned = {
      model: "openrouter/some-model",
      apiKeys: { openai: "sk-old" },
      injected: { hooks: "evil" },
    };
    await writeFile(join(dir, "keywork.json"), JSON.stringify(poisoned), "utf8");

    await saveApiKey("openrouter", "sk-or-new", dir);

    expect(await savedConfig(dir)).toEqual({
      model: "openrouter/some-model",
      apiKeys: { openai: "sk-old", openrouter: "sk-or-new" },
    });
  });

  it("starts clean when known fields fail validation", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "keywork.json"), JSON.stringify({ model: 42 }), "utf8");

    await saveApiKey("openai", "sk-fresh", dir);

    expect(await savedConfig(dir)).toEqual({ apiKeys: { openai: "sk-fresh" } });
  });

  it("tolerates a malformed config file", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "keywork.json"), "not json", "utf8");

    await saveApiKey("openai", "sk-fresh", dir);

    expect(await savedConfig(dir)).toEqual({ apiKeys: { openai: "sk-fresh" } });
  });
});
