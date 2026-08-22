import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ConnectionDraft,
  ConnectionsPort,
  ConnectionTarget,
  VerificationOutcome,
} from "@keywork/tui";
import { afterEach, describe, expect, it } from "vitest";
import { type ConnectIo, connectCommand, readMaskedLine, saveApiKey } from "./setup.ts";

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
  async function savedAuth(dir: string): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(join(dir, "auth.json"), "utf8"));
  }

  it("writes an api_key credential under the provider name", async () => {
    const dir = await tempDir();

    await saveApiKey("openrouter", "sk-or-new", dir);

    expect(await savedAuth(dir)).toEqual({
      openrouter: { type: "api_key", key: "sk-or-new" },
    });
  });

  it("keeps other providers' credentials and never touches keywork.json", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "keywork.json"), JSON.stringify({ model: "some-model" }), "utf8");
    await saveApiKey("openai", "sk-old", dir);

    await saveApiKey("openrouter", "sk-or-new", dir);

    expect(await savedAuth(dir)).toEqual({
      openai: { type: "api_key", key: "sk-old" },
      openrouter: { type: "api_key", key: "sk-or-new" },
    });
    expect(JSON.parse(await readFile(join(dir, "keywork.json"), "utf8"))).toEqual({
      model: "some-model",
    });
  });

  it("tolerates a malformed auth file", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "auth.json"), "not json", "utf8");

    await saveApiKey("openai", "sk-fresh", dir);

    expect(await savedAuth(dir)).toEqual({ openai: { type: "api_key", key: "sk-fresh" } });
  });
});

describe("connectCommand", () => {
  const ollama: ConnectionTarget = {
    id: "ollama",
    label: "Ollama",
    kind: "local",
    name: "ollama",
    endpoint: "http://localhost:11434/v1",
    protocol: "chat-completions",
    credential: "none",
    endpointEditable: true,
    nameEditable: true,
  };

  const custom: ConnectionTarget = {
    ...ollama,
    id: "custom",
    label: "Custom",
    kind: "custom",
    name: "",
    endpoint: "",
    credential: "api-key",
  };

  function fakePort(verification: VerificationOutcome) {
    const saves: ConnectionDraft[] = [];
    const port: ConnectionsPort = {
      targets: () => [ollama, custom],
      saved: () => [],
      draftFor: () => ({
        name: "ollama",
        endpoint: ollama.endpoint,
        protocol: "chat-completions",
        credential: "none",
        apiKey: "",
        insecureTransport: false,
      }),
      verify: async () => verification,
      save: async (draft) => {
        saves.push(draft);
      },
      remove: async () => ({ removed: [], retained: [] }),
    };
    return { port, saves };
  }

  function scriptedIo(
    answers: string[],
    secrets: string[] = [],
  ): ConnectIo & { printed: string[] } {
    const printed: string[] = [];
    return {
      printed,
      ask: async () => answers.shift() ?? "",
      askSecret: async () => secrets.shift() ?? "",
      print: (line) => printed.push(line),
    };
  }

  it("walks target → draft → verify → save and reports the receipt", async () => {
    const { port, saves } = fakePort({
      ok: true,
      at: "2026-08-21T12:00:00.000Z",
      models: ["qwen3"],
    });
    const io = scriptedIo(["1", "", ""]);

    const code = await connectCommand(port, { io });

    expect(code).toBe(0);
    expect(saves).toEqual([
      {
        name: "ollama",
        endpoint: "http://localhost:11434/v1",
        protocol: "chat-completions",
        credential: "none",
        apiKey: "",
        insecureTransport: false,
      },
    ]);
    expect(io.printed.join("\n")).toContain("Saved ollama · models reported: qwen3");
  });

  it("prefills from an argument URL and saves nothing when verification fails", async () => {
    const { port, saves } = fakePort({ ok: false, at: "t", reason: "HTTP 401" });
    const io = scriptedIo(["lab", "http://localhost:9/v1"]);

    const code = await connectCommand(port, { io, argument: "http://localhost:9/v1" });

    expect(code).toBe(1);
    expect(saves).toEqual([]);
    expect(io.printed.at(-1)).toBe("not saved: HTTP 401");
  });

  it("refuses an unknown argument without touching the network", async () => {
    const { port, saves } = fakePort({ ok: true, at: "t", models: [] });
    const io = scriptedIo([]);
    expect(await connectCommand(port, { io, argument: "mystery" })).toBe(1);
    expect(saves).toEqual([]);
  });
});
