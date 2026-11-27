import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import {
  CapabilityCache,
  type CreatureHost,
  createTailnet,
  type ModelEpisode,
  type ModelReference,
  type Provider,
  type RunRow,
} from "@keywork/engine";
import { EventLog, type WirePayload } from "@keywork/server";
import { type KeyworkConfig, loadConfig } from "@keywork/shared";
import { scratchDirs } from "@keywork/shared/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pingFailure } from "../../engine/src/mesh/transport/ping.ts";
import { parseStatus } from "../../engine/src/mesh/transport/status.ts";
import { recordedText } from "../../engine/src/mesh/transport/testing/recorded.ts";
import { connectionsPort } from "./inference/connections.ts";
import { readObservations } from "./inference/observations.ts";
import { composeInference } from "./inference/runtime.ts";
import { workspaceStateDir } from "./node/paths.ts";
import { servedHost } from "./serve.ts";

const tempDir = scratchDirs("keywork-local-models-");
const closing: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
});

describe("a model server on the stead", () => {
  it("lets a creature talk as itself, with its tools, on a keyless server connected while the engine runs", async () => {
    const mill = await standIn("openai-compatible");
    const world = await localWorld({});
    const pip = await world.creature("Pip");
    const connections = connectionsPort({
      env: {},
      userDir: world.userDir,
      config: () => ({}),
      credentials: () => ({}),
      observations: () => ({}),
      changed: async () => undefined,
    });
    const draft = {
      name: "mill",
      endpoint: `${mill.url}/v1`,
      protocol: "chat-completions",
      credential: "none",
      apiKey: "",
      insecureTransport: false,
    } as const;
    const verified = await connections.verify(draft);
    if (!verified.ok) throw new Error(verified.reason);

    await connections.save(draft, verified);
    await vi.waitFor(() => expect(world.reasons()).toContain("connections"), { timeout: 10_000 });
    await world.host.prompt(pip, "Who are you?");
    await world.settled(pip);

    const [turn] = mill.turns;
    expect(turn?.messages[0]?.content).toMatch(/^You are Pip, /);
    expect(turn?.tools?.map((tool) => tool.function.name)).toContain("write");
  });

  it("runs a chore on a local model whose decode was never measured, and measures it from that run", async () => {
    const mill = await standIn("ollama");
    const world = await localWorld({
      model: "mill/puppet",
      connections: { mill: { endpoint: `${mill.url}/v1`, models: ["puppet"] } },
    });
    await world.creatures.create({ name: "Pip" });
    const routines = world.host.routines;
    if (routines === undefined) throw new Error("no chores in this workspace");
    await routines.put("pip", "look", {
      title: "Look around",
      instructions: "Say in one line what you would look at first.",
      trigger: { kind: "manual" },
    });

    await routines.run("pip", "look");

    const run = await vi.waitFor(
      () => {
        const finished = world.finished();
        if (finished === undefined) throw new Error("the run has not finished");
        return finished;
      },
      { timeout: 20_000 },
    );
    expect(run).toMatchObject({ process: "completed", delivery: "delivered" });
    expect(world.capabilities.record(mill.url, "puppet")?.decodeTokensPerSecond).toMatchObject({
      known: true,
      evidence: { source: "measured" },
    });
  });

  it("says on a creature's profile, and live when it changes, which model its conversation talks on and that it only talks", async () => {
    const spare = await standIn("openai-compatible");
    const mill = await standIn("talk-only");
    const world = await localWorld({
      model: "spare/puppet",
      connections: {
        spare: { endpoint: `${spare.url}/v1`, models: ["puppet"] },
        mill: { endpoint: `${mill.url}/v1`, models: ["puppet"] },
      },
    });
    await world.creatures.create({ name: "Pip" });
    expect((await world.creatures.read("pip"))?.talking).toEqual({
      provider: "spare",
      model: "puppet",
      mode: "tools",
    });

    await world.creatures.update("pip", {
      models: { strong: { provider: "mill", model: "puppet" } },
    });

    const onlyTalks = {
      provider: "mill",
      model: "puppet",
      mode: "chat",
      detail:
        "mill/puppet answered without calling a tool when it was asked to, so it can talk but cannot use tools.",
    };
    await vi.waitFor(
      () => expect(world.seen("creature.talking")).toEqual([{ slug: "pip", talking: onlyTalks }]),
      { timeout: 10_000 },
    );
    expect((await world.creatures.read("pip"))?.talking).toEqual(onlyTalks);
  });

  it("offers, for a model that stopped answering or a model refused, the models another connected server reports though no connection lists any", async () => {
    const spare = await standIn("openai-compatible");
    const silent = await silentAddress();
    const world = await localWorld(
      {
        connections: {
          mill: { endpoint: `${silent}/v1` },
          spare: { endpoint: `${spare.url}/v1` },
        },
      },
      ({ userRoot, cwd }) =>
        keptRepairs(userRoot, cwd, [
          failedRepair("pip", { provider: "mill", model: "puppet" }, silent),
        ]),
    );
    await world.creatures.create({
      name: "Pip",
      models: { strong: { provider: "mill", model: "puppet" } },
    });

    const kept = await world.host.promises?.view("pip");

    expect(kept?.questions).toEqual([
      expect.objectContaining({
        sentence: "Pip's model is not answering. Is its server running?",
        choices: [
          { id: "retry", label: "Try again" },
          {
            id: "model",
            label: "Choose another model",
            models: [{ provider: "spare", model: "puppet" }],
          },
        ],
      }),
    ]);
    await expect(
      world.host.creatures?.update("pip", {
        models: { strong: { provider: "ghost", model: "x" } },
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("These would answer when you talk with it: spare/puppet."),
      usable: ["spare/puppet"],
    });
  });
});

interface StandIn {
  url: string;
  turns: { messages: { content?: unknown }[]; tools?: { function: { name: string } }[] }[];
}

async function standIn(kind: "ollama" | "openai-compatible" | "talk-only"): Promise<StandIn> {
  const turns: StandIn["turns"] = [];
  const native: Record<string, unknown> = {
    "GET /api/version": { version: "0.21.0" },
    "GET /api/tags": { models: [{ name: "puppet", model: "puppet" }] },
    "GET /api/ps": { models: [{ name: "puppet", model: "puppet", context_length: 131_072 }] },
    "POST /api/show": { capabilities: ["completion", "tools"] },
  };
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const route = `${request.method} ${request.url}`;
    const json = (body: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (kind === "ollama" && route in native) return json(native[route]);
    if (route === "GET /v1/models") return json({ object: "list", data: [{ id: "puppet" }] });
    if (route !== "POST /v1/chat/completions") {
      response.writeHead(404);
      return response.end();
    }
    const body = JSON.parse(raw);
    if (body.stream !== true && kind === "talk-only") {
      const words = { role: "assistant", content: "I would rather talk." };
      return json({ choices: [{ index: 0, message: words }] });
    }
    if (body.stream !== true) {
      const call = {
        id: "probe",
        type: "function",
        function: { name: "keywork_probe_ping", arguments: "{}" },
      };
      return json({ choices: [{ index: 0, message: { role: "assistant", tool_calls: [call] } }] });
    }
    turns.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const word of ["Hello, ", "I am ", "Pip."]) {
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: word } }] })}\n\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    const done = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
    const usage = { choices: [], usage: { prompt_tokens: 100, completion_tokens: 12 } };
    response.write(`data: ${JSON.stringify(done)}\n\ndata: ${JSON.stringify(usage)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closing.push(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, turns };
}

async function localWorld(
  config: KeyworkConfig,
  before?: (place: { userRoot: string; cwd: string }) => Promise<void>,
) {
  stubNetworkBeyondLoopback();
  const userRoot = await tempDir();
  const userDir = join(userRoot, ".keywork");
  await mkdir(userDir, { recursive: true });
  await writeFile(join(userDir, "keywork.json"), JSON.stringify(config));
  const cwd = await tempDir();
  await mkdir(join(cwd, ".keywork", "memory"), { recursive: true });
  await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "local" }));
  await before?.({ userRoot, cwd });
  const capabilities = new CapabilityCache();
  const load = async () => {
    const loaded = await loadConfig({
      userDir,
      projectDir: join(cwd, ".keywork"),
      projectTrusted: true,
    });
    const observations = await readObservations(userDir);
    return {
      config: loaded,
      runtime: composeInference({
        env: {},
        config: loaded,
        credentials: {},
        observations,
        localServers: capabilities,
      }),
    };
  };
  let state = await load();
  const current = (): Provider => {
    const resolved = state.runtime.resolve({ default: state.config.model });
    return resolved.ok ? state.runtime.provider(resolved.binding) : noModelYet;
  };
  const log = new EventLog();
  const host = await servedHost({
    cwd,
    sessionDir: await tempDir(),
    userRoot,
    projectTrusted: true,
    provider: noModelYet,
    currentProvider: current,
    refreshInference: async () => {
      state = await load();
    },
    inference: {
      bind: (reference) => state.runtime.registry.bind(reference),
      provider: (binding) => state.runtime.provider(binding),
    },
    inventory: {
      capabilities,
      registrations: () => state.runtime.registry.all(),
      provider: (binding) => state.runtime.provider(binding),
      decider: (binding) => state.runtime.decider(binding),
      headersFor: (registration) => state.runtime.headersFor(registration),
    },
    tailnet: recordedTailnet(),
    permissions: () => "deny",
    checkpoints: "off",
    log,
  });
  closing.push(() => host.close?.() ?? Promise.resolve());
  const creatures = host.creatures as CreatureHost;
  const seen = (type: string) =>
    log
      .since(0)
      .filter((envelope) => envelope.type === type)
      .map((envelope) => envelope.payload);
  return {
    host,
    creatures,
    userDir,
    capabilities,
    seen,
    reasons: () => seen("models.changed").map((change) => (change as { reason: string }).reason),
    finished: (): RunRow | undefined =>
      (seen("routine.finished").at(-1) as WirePayload<"routine.finished"> | undefined)?.run,
    creature: async (name: string) => {
      const made = await creatures.create({ name });
      const detail = await creatures.read(made.slug);
      if (detail === undefined) throw new Error("creature missing");
      return detail.conversation;
    },
    settled: (id: string) =>
      vi.waitFor(
        async () =>
          expect((await host.list()).find((session) => session.id === id)?.working).toBe(false),
        { timeout: 10_000 },
      ),
  };
}

async function silentAddress(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

async function keptRepairs(
  userRoot: string,
  cwd: string,
  episodes: readonly ModelEpisode[],
): Promise<void> {
  const file = join(workspaceStateDir(userRoot, cwd), "promises", "model-repairs.json");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(episodes));
}

function failedRepair(creature: string, reference: ModelReference, endpoint: string): ModelEpisode {
  return {
    creature,
    reference,
    endpoint,
    subject: `${reference.provider}/${reference.model}`,
    startedAt: "2026-11-26T09:00:00.000Z",
    tries: 3,
    bound: 3,
    nextAt: null,
    endedAt: "2026-11-26T09:03:30.000Z",
    outcome: "failed",
  };
}

const noModelYet: Provider = {
  name: "model-setup",
  stream: () => {
    throw new Error("No model is connected yet");
  },
};

function stubNetworkBeyondLoopback(): void {
  const reach = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return url.hostname === "127.0.0.1"
        ? reach(input, init)
        : new Response("{}", { status: 503 });
    }),
  );
}

function recordedTailnet() {
  return createTailnet({
    name: "recorded",
    status: async () => parseStatus(recordedText("status-running")),
    whois: async () => null,
    ping: async () => pingFailure("unused"),
    serve: async () => ({ serving: false, funnel: [] }),
  });
}
