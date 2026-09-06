import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { scratchDirs } from "@keywork/shared/testing";
import type {
  ConnectionDraft,
  ConnectionsPort,
  ConnectionTarget,
  VerificationOutcome,
} from "@keywork/tui";
import { describe, expect, it } from "vitest";
import { type ConnectIo, connectCommand, saveApiKey, terminalConnectIo } from "./setup.ts";

const tempDir = scratchDirs("keywork-setup-");

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
    draftFor: (target) => ({
      name: target.name,
      endpoint: target.endpoint,
      protocol: "chat-completions",
      credential: target.credential === "api-key" ? "api-key" : "none",
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

function scriptedIo(answers: string[], secrets: string[] = []): ConnectIo & { printed: string[] } {
  const printed: string[] = [];
  return {
    printed,
    ask: async () => answers.shift() ?? "",
    askSecret: async () => secrets.shift() ?? "",
    print: (line) => printed.push(line),
  };
}

describe("connectCommand", () => {
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

  it("closes the io it was handed once the command is over", async () => {
    const { port } = fakePort({ ok: true, at: "t", models: [] });
    let closed = 0;
    const io = { ...scriptedIo([]), close: () => (closed += 1) };

    await connectCommand(port, { io, argument: "mystery" });

    expect(closed).toBe(1);
  });
});

describe("connectCommand without a terminal", () => {
  it("reads every answer, the key included, line by line from piped stdin", async () => {
    const { port, saves } = fakePort({ ok: true, at: "t", models: ["m"] });
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on("data", (chunk: Buffer | string) => written.push(chunk.toString()));
    input.write("2\nlab\nhttp://localhost:9/v1\nsk-piped-key\n");

    const code = await connectCommand(port, { io: terminalConnectIo({ input, output }) });

    expect(code).toBe(0);
    expect(saves).toEqual([
      {
        name: "lab",
        endpoint: "http://localhost:9/v1",
        protocol: "chat-completions",
        credential: "api-key",
        apiKey: "sk-piped-key",
        insecureTransport: false,
      },
    ]);
    expect(written.join("")).toContain("Choice [1]: ");
    expect(written.join("")).not.toContain("sk-piped-key");
  });
});
