import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "@keywork/engine";
import type { KeyworkConfig } from "@keywork/shared";
import type { ConnectionDraft, ConnectionsPort } from "@keywork/tui";
import { afterEach, describe, expect, it } from "vitest";
import { type CredentialMap, readCredentials } from "../auth-store.ts";
import { readUserConfig } from "../user-config.ts";
import { type ConnectionsDeps, connectionsPort } from "./connections.ts";
import { type ObservationMap, readObservations } from "./observations.ts";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-connections-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const now = () => new Date("2026-08-21T12:00:00.000Z");

interface Harness {
  port: ConnectionsPort;
  calls: { url: string; headers: Record<string, string> }[];
  reloads: number;
  dir: string;
}

async function harness(
  overrides: Partial<ConnectionsDeps> & { models?: string[]; status?: number } = {},
): Promise<Harness> {
  const dir = await tempDir();
  const calls: Harness["calls"] = [];
  const state = {
    config: {} as KeyworkConfig,
    credentials: {} as CredentialMap,
    observations: {} as ObservationMap,
    reloads: 0,
  };
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
    return new Response(
      JSON.stringify({ data: (overrides.models ?? ["m1"]).map((id) => ({ id })) }),
      {
        status: overrides.status ?? 200,
      },
    );
  };
  const port = connectionsPort({
    env: {},
    userDir: dir,
    config: () => state.config,
    credentials: () => state.credentials,
    observations: () => state.observations,
    fetchFn,
    now,
    changed: async () => {
      state.reloads += 1;
      state.config = await readUserConfig(dir);
      state.credentials = await readCredentials(dir);
      state.observations = await readObservations(dir);
    },
    ...overrides,
  });
  return {
    port,
    calls,
    dir,
    get reloads() {
      return state.reloads;
    },
  };
}

function draft(overrides: Partial<ConnectionDraft> = {}): ConnectionDraft {
  return {
    name: "ollama",
    endpoint: "http://localhost:11434/v1",
    protocol: "chat-completions",
    credential: "none",
    apiKey: "",
    insecureTransport: false,
    ...overrides,
  };
}

describe("connectionsPort targets", () => {
  it("lists api-key built-ins, conventional local templates, and a custom entry, in that order", async () => {
    const { port } = await harness();
    const targets = port.targets();
    expect(targets.map((target) => [target.id, target.kind])).toEqual([
      ["openrouter", "built-in"],
      ["openai", "built-in"],
      ["ollama", "local"],
      ["lmstudio", "local"],
      ["llamacpp", "local"],
      ["vllm", "local"],
      ["custom", "custom"],
    ]);
    const ollama = targets.find((target) => target.id === "ollama");
    expect(port.draftFor(ollama as NonNullable<typeof ollama>)).toEqual(draft());
  });

  it("opens a surface without touching the network", async () => {
    const { port, calls } = await harness();
    port.targets();
    port.saved();
    expect(calls).toHaveLength(0);
  });
});

describe("connectionsPort verify and save", () => {
  it("verifies with one GET, then persists the connection, observations, and no credential for loopback", async () => {
    const { port, calls, dir } = await harness({ models: ["qwen3", "llama3"] });
    const verification = await port.verify(draft());
    expect(calls).toEqual([
      {
        url: "http://localhost:11434/v1/models",
        headers: expect.objectContaining({ accept: "application/json" }),
      },
    ]);
    expect(verification).toEqual({
      ok: true,
      at: "2026-08-21T12:00:00.000Z",
      models: ["llama3", "qwen3"],
    });
    if (!verification.ok) return;

    await port.save(draft(), verification);

    expect(await readUserConfig(dir)).toEqual({
      connections: { ollama: { endpoint: "http://localhost:11434/v1" } },
    });
    expect(await readCredentials(dir)).toEqual({});
    expect(await readObservations(dir)).toEqual({
      ollama: {
        verifiedAt: verification.at,
        modelsReportedAt: verification.at,
        models: ["llama3", "qwen3"],
      },
    });
    expect(port.saved().map((row) => [row.name, row.credential, row.modelCount])).toEqual([
      ["ollama", "no credential", 2],
    ]);
  });

  it("sends the typed key as a bearer header and saves it under the connection name, keeping config secret-free", async () => {
    const { port, calls, dir } = await harness();
    const remote = draft({
      name: "broker",
      endpoint: "https://broker.example/v1",
      credential: "api-key",
      apiKey: "sk-live",
    });
    const verification = await port.verify(remote);
    expect(calls[0]?.headers).toMatchObject({ authorization: "Bearer sk-live" });
    if (!verification.ok) return;

    await port.save(remote, verification);

    expect(await readUserConfig(dir)).toEqual({
      connections: { broker: { endpoint: "https://broker.example/v1" } },
    });
    expect(await readCredentials(dir)).toEqual({ broker: { type: "api_key", key: "sk-live" } });
    expect(JSON.parse(await readFile(join(dir, "keywork.json"), "utf8"))).not.toContain("sk-live");
  });

  it("writes only non-default fields: protocol, env credential, and insecure transport", async () => {
    const { port, dir } = await harness();
    const lan = draft({
      name: "lan",
      endpoint: "http://10.0.0.9:8080/v1",
      protocol: "responses",
      credential: "env:LAN_KEY",
      insecureTransport: true,
    });
    const verification = await port.verify(lan);
    if (!verification.ok) return;
    await port.save(lan, verification);
    expect(await readUserConfig(dir)).toEqual({
      connections: {
        lan: {
          endpoint: "http://10.0.0.9:8080/v1",
          protocol: "responses",
          credential: "env:LAN_KEY",
          insecureTransport: true,
        },
      },
    });
  });

  it("saves a built-in's key to auth.json without adding a connections entry", async () => {
    const { port, dir } = await harness();
    const openai = draft({
      name: "openai",
      endpoint: "https://api.openai.com/v1",
      credential: "api-key",
      apiKey: "sk-x",
    });
    const verification = await port.verify(openai);
    if (!verification.ok) return;
    await port.save(openai, verification);
    expect(await readUserConfig(dir)).toEqual({});
    expect(await readCredentials(dir)).toEqual({ openai: { type: "api_key", key: "sk-x" } });
    expect(port.saved().map((row) => [row.name, row.builtIn, row.credential])).toEqual([
      ["openai", true, "saved key"],
    ]);
  });

  it("leaves nothing durable when verification fails", async () => {
    const { port, dir } = await harness({ status: 401 });
    const verification = await port.verify(
      draft({
        name: "broker",
        endpoint: "https://b.example/v1",
        credential: "api-key",
        apiKey: "k",
      }),
    );
    expect(verification).toMatchObject({ ok: false, reason: expect.stringContaining("HTTP 401") });
    expect(await readUserConfig(dir)).toEqual({});
    expect(await readCredentials(dir)).toEqual({});
  });

  it("reuses the saved key when an edit leaves the key field blank", async () => {
    const { port, calls } = await harness();
    const first = draft({
      name: "broker",
      endpoint: "https://b.example/v1",
      credential: "api-key",
      apiKey: "sk-1",
    });
    const verification = await port.verify(first);
    if (!verification.ok) return;
    await port.save(first, verification);
    const saved = port.saved().find((row) => row.name === "broker");
    const edit = port.draftFor(saved as NonNullable<typeof saved>);
    expect(edit).toMatchObject({ name: "broker", credential: "api-key", apiKey: "" });
    await port.verify(edit);
    expect(calls.at(-1)?.headers).toMatchObject({ authorization: "Bearer sk-1" });
  });
});

describe("connectionsPort remove", () => {
  it("removes the connection and its owned key together and names both", async () => {
    const { port, dir } = await harness();
    const broker = draft({
      name: "broker",
      endpoint: "https://b.example/v1",
      credential: "api-key",
      apiKey: "sk-1",
    });
    const verification = await port.verify(broker);
    if (!verification.ok) return;
    await port.save(broker, verification);

    const receipt = await port.remove("broker");

    expect(receipt).toEqual({
      removed: ["connection broker", "saved key for broker"],
      retained: [],
    });
    expect(await readUserConfig(dir)).toEqual({ connections: {} });
    expect(await readCredentials(dir)).toEqual({});
    expect(await readObservations(dir)).toEqual({});
    expect(port.saved()).toEqual([]);
  });

  it("keeps environment credentials and says so", async () => {
    const { port } = await harness({ env: { OPENAI_API_KEY: "ambient" } });
    const receipt = await port.remove("openai");
    expect(receipt).toEqual({
      removed: [],
      retained: ["OPENAI_API_KEY (environment variables are never deleted)"],
    });
  });
});
