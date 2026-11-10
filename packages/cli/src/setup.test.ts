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
import { typesafeDecider } from "./inference/builtins.ts";
import { type DeciderConnection, typesafeTerms } from "./inference/typesafe-connection.ts";
import type { VerificationReport } from "./inference/verify.ts";
import { typesafeRefusal } from "./memory-decider.ts";
import { type ConnectIo, connectCommand, saveApiKey, terminalConnectIo } from "./setup.ts";
import type { FirstModelSetup } from "./setup-model.ts";

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

function fakePort(
  verification: VerificationOutcome,
  targets: readonly ConnectionTarget[] = [ollama, custom],
) {
  const saves: ConnectionDraft[] = [];
  const port: ConnectionsPort = {
    targets: () => targets,
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

const openai: ConnectionTarget = {
  id: "openai",
  label: "OpenAI",
  kind: "built-in",
  name: "openai",
  endpoint: "https://api.openai.com/v1",
  protocol: "chat-completions",
  credential: "api-key",
  endpointEditable: false,
  nameEditable: false,
};

function firstModelHarness(
  standing: ReturnType<FirstModelSetup["standing"]> = {
    kind: "needs-model",
    configured: undefined,
    reason: "2 models could be the default",
  },
) {
  const remembered: { reference: string; previous: string | undefined }[] = [];
  const firstModel: FirstModelSetup = {
    refresh: async () => undefined,
    standing: () => standing,
    choices: () => ["openai/alpha", "openai/beta"],
    check: () => undefined,
    remember: async (reference, previous) => {
      remembered.push({ reference, previous });
      return undefined;
    },
  };
  return { firstModel, remembered };
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

describe("guided model setup", () => {
  it("offers the three routes and confirms the starting model separately from saving a key", async () => {
    const { port, saves } = fakePort({ ok: true, at: "t", models: ["alpha", "beta"] }, [openai]);
    const { firstModel, remembered } = firstModelHarness();
    const io = scriptedIo(["2", "1", "2", "y"], ["fake-key"]);

    expect(await connectCommand(port, { firstModel, io })).toBe(0);

    expect(io.printed).toEqual(
      expect.arrayContaining([
        "  1. Local",
        "  2. Flagship AI direct",
        "  3. OpenRouter",
        "Selected openai/beta for this setup.",
      ]),
    );
    expect(saves).toEqual([expect.objectContaining({ name: "openai" })]);
    expect(remembered).toEqual([{ reference: "openai/beta", previous: undefined }]);
  });

  it("keeps the connection and leaves the starting model alone when the user declines", async () => {
    const { port, saves } = fakePort({ ok: true, at: "t", models: ["alpha", "beta"] }, [openai]);
    const { firstModel, remembered } = firstModelHarness();
    const io = scriptedIo(["1", "2", ""], ["fake-key"]);

    expect(await connectCommand(port, { group: "flagship", firstModel, io })).toBe(0);

    expect(saves).toHaveLength(1);
    expect(remembered).toEqual([]);
    expect(io.printed).toContain("Starting model unchanged.");
  });

  it("uses an existing resolved preference without reopening provider setup", async () => {
    const { port, saves } = fakePort({ ok: true, at: "t", models: [] });
    const { firstModel, remembered } = firstModelHarness({
      kind: "available",
      reference: "openrouter/openai/gpt-5-mini",
      configured: "openrouter/openai/gpt-5-mini",
    });
    const io = scriptedIo([]);

    expect(await connectCommand(port, { firstModel, io })).toBe(0);

    expect(io.printed).toEqual(["Starting model: openrouter/openai/gpt-5-mini"]);
    expect(saves).toEqual([]);
    expect(remembered).toEqual([]);
  });

  it("confirms a sole candidate before writing the first starting model", async () => {
    const { port, saves } = fakePort({ ok: true, at: "t", models: [] });
    const { firstModel, remembered } = firstModelHarness({
      kind: "available",
      reference: "ollama/qwen",
      configured: undefined,
    });
    const io = scriptedIo(["y"]);

    expect(await connectCommand(port, { firstModel, io })).toBe(0);

    expect(saves).toEqual([]);
    expect(remembered).toEqual([{ reference: "ollama/qwen", previous: undefined }]);
  });

  it("offers the connected provider's model while keeping an existing starting model on decline", async () => {
    const { port } = fakePort({ ok: true, at: "t", models: ["qwen"] });
    const { firstModel, remembered } = firstModelHarness({
      kind: "available",
      reference: "openrouter/openai/gpt-5-mini",
      configured: "openrouter/openai/gpt-5-mini",
    });
    firstModel.choices = (provider) => (provider === "ollama" ? ["ollama/qwen"] : []);
    const io = scriptedIo(["1", "", "", "1", "n"]);

    expect(await connectCommand(port, { firstModel, group: "local", io })).toBe(0);

    expect(io.printed).toContain("Starting model: openrouter/openai/gpt-5-mini");
    expect(io.printed).toContain("Selected ollama/qwen for this setup.");
    expect(io.printed).toContain("Starting model unchanged.");
    expect(remembered).toEqual([]);
  });

  it("puts discovered local models first after an explicit search", async () => {
    const { port, saves } = fakePort({ ok: true, at: "t", models: ["qwen"] });
    port.findLocal = async () => [{ target: ollama, models: ["qwen"] }];
    const io = scriptedIo(["y", "1", "", ""]);

    expect(await connectCommand(port, { group: "local", io })).toBe(0);

    expect(io.printed).toContain("  1. Ollama · models reported: qwen");
    expect(saves).toEqual([expect.objectContaining({ name: "ollama", credential: "none" })]);
  });

  it("offers local setup guidance and keeps the nonsecret draft when the endpoint is malformed", async () => {
    const { port, saves } = fakePort({ ok: true, at: "t", models: ["alpha"] });
    const prompts: string[] = [];
    const script = scriptedIo(["2", "lab", "bad-url", "y", "", "http://localhost:6789/v1"]);
    const io: ConnectIo = {
      ...script,
      ask: (prompt) => {
        prompts.push(prompt);
        return script.ask(prompt);
      },
      askSecret: async (prompt) => {
        prompts.push(prompt);
        return "";
      },
    };

    expect(await connectCommand(port, { group: "local", io })).toBe(0);

    expect(prompts).toContain("Name [lab]: ");
    expect(prompts).toContain("Endpoint [bad-url]: ");
    expect(prompts.filter((prompt) => prompt.includes("API key"))).toHaveLength(1);
    expect(script.printed).toContain("not saved: endpoint must be an http(s) URL");
    expect(script.printed.join("\n")).toContain("https://docs.ollama.com/quickstart");
    expect(script.printed.join("\n")).toContain(
      "https://lmstudio.ai/docs/developer/rest/quickstart",
    );
    expect(script.printed.join("\n")).toContain("model list checked t");
    expect(saves).toEqual([
      expect.objectContaining({ name: "lab", endpoint: "http://localhost:6789/v1" }),
    ]);
  });

  it("cancels a masked key entry before it can fall through to verification", async () => {
    const { port, saves } = fakePort({ ok: true, at: "t", models: ["alpha"] }, [openai]);
    port.verify = async () => {
      throw new Error("should never verify");
    };
    const io = { ...scriptedIo([]), askSecret: async () => undefined };

    expect(await connectCommand(port, { argument: "openai", io })).toBe(130);

    expect(saves).toEqual([]);
    expect(io.printed).toContain("Model setup cancelled.");
  });

  it("refuses insecure transport before asking for a key", async () => {
    const { port, saves } = fakePort({ ok: true, at: "t", models: ["alpha"] });
    const io = {
      ...scriptedIo(["lab", ""]),
      askSecret: async () => {
        throw new Error("should never ask for a key");
      },
    };

    expect(await connectCommand(port, { argument: "http://lab.example/v1", io })).toBe(1);

    expect(saves).toEqual([]);
    expect(io.printed).toContain("plain http off loopback is refused until you allow it");
  });
});

interface FakeDecider extends DeciderConnection {
  saved: string[];
  selections: number;
}

function fakeDecider(
  verification: VerificationReport,
  selected: "builtin" | "jev" = "builtin",
): FakeDecider {
  const saved: string[] = [];
  const decider: FakeDecider = {
    target: typesafeDecider,
    configFile: "/home/me/.keywork/keywork.json",
    saved,
    selections: 0,
    verify: async () => verification,
    save: async (key) => {
      saved.push(key);
    },
    selected: () => selected,
    select: async () => {
      decider.selections += 1;
      return "/home/me/.keywork/keywork.json";
    },
  };
  return decider;
}

const listed: VerificationReport = {
  ok: true,
  at: "2026-10-16T09:00:00.000Z",
  models: ["jev-latest", "jev-preview"],
};

describe("keywork connect typesafe", () => {
  it("states TypeSafe's terms, saves a verified key, and turns Jev on by default", async () => {
    const { port, saves } = fakePort({ ok: true, at: "t", models: [] });
    const decider = fakeDecider(listed);
    const io = scriptedIo([""], ["ts-live-key"]);

    const code = await connectCommand(port, { io, argument: "typesafe", decider });

    expect(code).toBe(0);
    expect(saves).toEqual([]);
    expect(decider.saved).toEqual(["ts-live-key"]);
    expect(decider.selections).toBe(1);
    expect(io.printed).toEqual([
      "keywork connect typesafe: TypeSafe Jev (memory decisions)",
      typesafeTerms,
      "\nverifying https://api.typesafe.ai/v1/models …",
      "\nSaved typesafe · models reported: jev-latest, jev-preview · verified 2026-10-16T09:00:00.000Z",
      "TypeSafe's list does not name jev-1.13.0 · keywork asks for it by version and checks the model behind every answer",
      'wrote "memory": { "decider": "jev" } to /home/me/.keywork/keywork.json',
    ]);
    expect(io.printed.join("\n")).not.toContain("ts-live-key");
  });

  it("leaves memory on the builtin when the answer is no, and says how to change that", async () => {
    const { port } = fakePort({ ok: true, at: "t", models: [] });
    const decider = fakeDecider({ ...listed, models: ["jev-1.13.0"] });
    const io = scriptedIo(["n"], ["ts-live-key"]);

    expect(await connectCommand(port, { io, argument: "typesafe", decider })).toBe(0);

    expect(decider.selections).toBe(0);
    expect(io.printed.at(-1)).toBe(
      'memory decider stays builtin · "memory": { "decider": "jev" } in /home/me/.keywork/keywork.json turns Jev on',
    );
    expect(io.printed.join("\n")).not.toContain("does not name");
  });

  it("asks nothing more when jev is already selected", async () => {
    const { port } = fakePort({ ok: true, at: "t", models: [] });
    const decider = fakeDecider(listed, "jev");
    const io = scriptedIo([], ["ts-live-key"]);

    expect(await connectCommand(port, { io, argument: "typesafe", decider })).toBe(0);

    expect(decider.selections).toBe(0);
    expect(io.printed.at(-1)).toBe(
      "memory decider: jev, already set in /home/me/.keywork/keywork.json",
    );
  });

  it("saves nothing when TypeSafe refuses the key", async () => {
    const { port } = fakePort({ ok: true, at: "t", models: [] });
    const decider = fakeDecider({ ok: false, at: "t", reason: typesafeRefusal, status: 401 });
    const io = scriptedIo([], ["ts-bad-key"]);

    expect(await connectCommand(port, { io, argument: "typesafe", decider })).toBe(1);

    expect(decider.saved).toEqual([]);
    expect(io.printed.at(-1)).toBe("not saved: TypeSafe refused the key");
  });

  it("saves nothing without a key", async () => {
    const { port } = fakePort({ ok: true, at: "t", models: [] });
    const decider = fakeDecider(listed);
    const io = scriptedIo([], [""]);

    expect(await connectCommand(port, { io, argument: "typesafe", decider })).toBe(1);
    expect(io.printed.at(-1)).toBe("not saved: typesafe needs an API key");
  });

  it("lists TypeSafe under its own heading, apart from the chat providers", async () => {
    const { port } = fakePort({ ok: true, at: "t", models: [] });
    const decider = fakeDecider(listed);
    const io = scriptedIo(["4", ""], ["ts-live-key"]);

    expect(await connectCommand(port, { io, decider })).toBe(0);

    expect(io.printed.slice(0, 6)).toEqual([
      "keywork connect: add an inference provider\n",
      "  1. Ollama · http://localhost:11434/v1",
      "  2. Custom OpenAI-compatible endpoint (URL)",
      "  3. OpenAI via ChatGPT Plus/Pro (subscription sign-in)",
      "\nmemory decisions:",
      "  4. TypeSafe Jev (memory decisions)",
    ]);
    expect(decider.saved).toEqual(["ts-live-key"]);
  });
});
