import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  blankRecord,
  CapabilityCache,
  type CreatureHost,
  InferenceRegistry,
  known,
  ModelInventory,
  type ModelReference,
  type Provider,
  type ProviderRegistration,
  type ProviderRequest,
  unknownCapability,
} from "@keywork/engine";
import { EventLog } from "@keywork/server";
import { scratchDirs } from "@keywork/shared/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ServedHostOptions, servedHost } from "./serve.ts";
import { configuredLoopbackModels, refreshableModels } from "./serve-models.ts";
import { findSession } from "./sessions/store.ts";

const tempDir = scratchDirs("keywork-serve-models-");
afterEach(() => vi.unstubAllGlobals());

describe("model refresh", () => {
  it("serializes an explicit tool check after an overlapping metadata refresh of the same endpoint", async () => {
    const metadata = Promise.withResolvers<void>();
    const checking = vi.fn();
    const probe = vi.fn(async (request: { behaviour?: boolean }) => {
      if (request.behaviour === true) checking();
      else await metadata.promise;
      return {};
    });
    const models = configuredLoopbackModels(
      { list: async () => ({}), probe },
      {
        registrations: () => [
          registration(recordedProvider("local", "model"), "http://localhost:1234/v1"),
        ],
      },
    );
    const listing = models.list({});
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    const explicit = models.probe({
      endpoint: "http://localhost:1234/v1",
      behaviour: true,
      refresh: true,
    });
    await Promise.resolve();
    expect(checking).not.toHaveBeenCalled();
    metadata.resolve();
    await Promise.all([listing, explicit]);
    expect(checking).toHaveBeenCalledTimes(1);
  });

  it("preserves an explicit tool-call probe only while the model fingerprint stays the same", async () => {
    const cache = new CapabilityCache();
    const root = "http://localhost:1234";
    let fingerprint = "same-loaded-instance";
    const metadata = () =>
      blankRecord(
        root,
        "model",
        {
          id: fingerprint,
          kind: "lm-studio",
          version: null,
          build: null,
          routes: ["/api/v1/models"],
        },
        "2026-11-10",
      );
    cache.store({
      ...metadata(),
      tools: known(true, { source: "behaviour-probe", probe: "tools" }),
    });
    const models = configuredLoopbackModels(
      {
        probe: async () => {
          cache.store(metadata());
          return {};
        },
        list: async () => ({}),
      },
      {
        registrations: () => [registration(recordedProvider("local", "model"), `${root}/v1`)],
        capabilities: cache,
      },
    );
    await models.list({});
    expect(cache.record(root, "model")?.tools).toMatchObject({
      known: true,
      value: true,
      evidence: { source: "behaviour-probe" },
    });
    fingerprint = "different-loaded-instance";
    await models.list({});
    expect(cache.record(root, "model")?.tools).toEqual(
      unknownCapability("no native route reported it"),
    );
  });

  it("rechecks loaded context at the configured localhost endpoint without a server-version change", async () => {
    let context = 4096;
    const cache = new CapabilityCache();
    const root = "http://localhost:11434";
    const inventory = new ModelInventory({
      nodes: async () => [],
      cache,
      http: {
        get: async (url) => {
          if (url === `${root}/api/version`) return reply({ version: "0.21.0" });
          if (url === `${root}/api/tags`) return reply({ models: [{ name: "local-model" }] });
          if (url === `${root}/api/ps`)
            return reply({ models: [{ name: "local-model", context_length: context }] });
          throw new Error(`unexpected metadata read ${url}`);
        },
        post: async (url) => {
          if (url === `${root}/api/show`) return reply({ capabilities: ["completion", "tools"] });
          throw new Error(`no inference request is allowed: ${url}`);
        },
      },
    });
    const models = configuredLoopbackModels(
      {
        probe: (request) => inventory.probe(request),
        list: async () => ({ context: cache.record(root, "local-model")?.contextAllocated }),
      },
      {
        registrations: () => [registration(recordedProvider("local", "local-model"), `${root}/v1`)],
        capabilities: cache,
      },
    );
    expect(await models.list({})).toMatchObject({ context: { known: true, value: 4096 } });
    context = 131_072;
    expect(await models.list({})).toMatchObject({ context: { known: true, value: 131_072 } });
    expect(cache.record("http://127.0.0.1:11434", "local-model")).toBeUndefined();
  });

  it("probes only exact configured loopback roots before reporting their current capabilities", async () => {
    const probe = vi.fn(async () => ({}));
    const list = vi.fn(async () => {
      expect(probe).toHaveBeenCalledTimes(1);
      return {};
    });
    const local = registration(recordedProvider("local", "model"), "http://localhost:1234/v1");
    const models = configuredLoopbackModels(
      { list, probe },
      {
        registrations: () => [
          local,
          { ...local, name: "another-name" },
          { ...local, name: "disabled", enabled: false, endpoint: "http://localhost:8080/v1" },
          { ...local, name: "cloud", endpoint: "https://cloud.invalid/v1" },
          { ...local, name: "tailnet", endpoint: "http://machine.ts.net:1234/v1" },
        ],
      },
    );
    await models.list({});
    expect(probe).toHaveBeenCalledExactlyOnceWith({
      endpoint: "http://localhost:1234",
      refresh: true,
    });
    await models.list({ node: "another-node" });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("shares concurrent refreshes and lists only after the replacement is ready", async () => {
    const loaded = Promise.withResolvers<void>();
    const reload = vi.fn(() => loaded.promise);
    const list = vi.fn(async () => ({ generation: 2 }));
    const models = refreshableModels({ list, probe: async () => ({}) }, reload);
    const first = models.refresh?.();
    const second = models.refresh?.();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
    loaded.resolve();
    expect(await first).toEqual({ generation: 2 });
    expect(await second).toEqual({ generation: 2 });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("does not claim a stale snapshot on failure and allows retry", async () => {
    const reload = vi
      .fn()
      .mockRejectedValueOnce(new Error("config unreadable"))
      .mockResolvedValue(undefined);
    const list = vi.fn(async () => ({ generation: 2 }));
    const models = refreshableModels({ list, probe: async () => ({}) }, reload);
    await expect(models.refresh?.()).rejects.toThrow("config unreadable");
    expect(list).not.toHaveBeenCalled();
    expect(await models.refresh?.()).toEqual({ generation: 2 });
    expect(refreshableModels({ list, probe: async () => ({}) }, undefined).refresh).toBeUndefined();
  });

  it("preserves workspace trust and permission grants", async () => {
    const world = await modelWorld({ projectTrusted: false });
    try {
      const trust = (await world.host.workspace?.report())?.trust;
      const permissions = await world.host.permissions();
      world.nextDefault(world.local);
      await world.host.models?.refresh?.();
      expect((await world.host.workspace?.report())?.trust).toEqual(trust);
      expect(await world.host.permissions()).toEqual(permissions);
      await expect(world.creatures.create({ name: "Pip" })).rejects.toThrow(/trusted workspace/);
    } finally {
      await world.host.close();
    }
  });
});

describe("the creature's first model", () => {
  it("binds the explicit choice saved after its conversation was opened", async () => {
    const world = await modelWorld();
    try {
      const id = await world.creature("Pip");
      await world.creatures.update("pip", { models: { strong: localChoice } });
      await world.host.prompt(id, "hello");
      await world.settled(id);
      expect(world.local.calls).toHaveLength(1);
      expect(world.cloud.calls).toHaveLength(0);
      expect((await findSession(world.sessionDir, id))?.modelSelection()).toMatchObject({
        provider: "local",
        modelId: "local-model",
      });
    } finally {
      await world.host.close?.();
    }
  });

  it("refuses an unavailable local choice without sending the prompt to the cloud", async () => {
    const world = await modelWorld();
    try {
      const id = await world.creature("Pip", { provider: "missing-local", model: "local-model" });
      await expect(world.host.prompt(id, "private hello")).rejects.toThrow();
      expect(world.cloud.calls).toHaveLength(0);
      expect(world.local.calls).toHaveLength(0);
    } finally {
      await world.host.close?.();
    }
  });

  it("keeps the measured capability requirement for creature work threads", async () => {
    const world = await modelWorld({ localContext: 4096 });
    try {
      await world.creature("Pip", localChoice);
      await world.creatures.update("pip", { models: { loop: localChoice } });
      const id = await world.creatures.openThread("pip", "thread");
      await expect(world.host.prompt(id, "private hello")).rejects.toThrow(/context/);
      expect(world.cloud.calls).toHaveLength(0);
      expect(world.local.calls).toHaveLength(0);
    } finally {
      await world.host.close?.();
    }
  });

  it("rejects the smaller conversation default for a project work session", async () => {
    const world = await modelWorld({ localContext: 4096 });
    world.nextDefault(world.local);
    await world.host.models?.refresh?.();
    const session = await world.host.create();
    await world.host.rename(session.id, "project work");
    await world.host.close();
    const store = await findSession(world.sessionDir, session.id);
    await store?.appendCustom("keywork.creature-project", {
      key: "project-work",
      creature: { workspace: "home", slug: "pip" },
    });
    const reopened = await world.reopen();
    try {
      await expect(reopened.prompt(session.id, "edit the project")).rejects.toThrow(/context/);
      expect(world.local.calls).toHaveLength(0);
      expect(world.cloud.calls).toHaveLength(0);
    } finally {
      await reopened.close();
    }
  });

  it("lets a smaller model answer the creature with no tool inputs", async () => {
    const world = await modelWorld({ localContext: 4096 });
    try {
      const id = await world.creature("Pip", localChoice);
      world.nextDefault(world.local);
      expect(await world.host.models?.refresh?.()).toMatchObject({
        conversation: { ...localChoice, mode: "chat" },
        inherits: { strong: { refused: "missing-capability" } },
      });
      await world.host.prompt(id, "hello");
      await world.settled(id);
      expect(world.local.calls).toHaveLength(1);
      expect(world.local.calls[0]?.tools).toEqual([]);
      expect(world.cloud.calls).toHaveLength(0);
    } finally {
      await world.host.close();
    }
  });

  it("keeps the conversation-only boundary through model switching and reopening", async () => {
    const world = await modelWorld({ localContext: 4096 });
    const id = await world.creature("Pip");
    await world.host.setModel(id, "local/local-model");
    await world.host.prompt(id, "hello");
    await world.settled(id);
    await world.host.close();
    const reopened = await world.reopen();
    try {
      await reopened.prompt(id, "hello again");
      await vi.waitFor(async () =>
        expect((await reopened.list()).find((row) => row.id === id)?.working).toBe(false),
      );
      expect(world.local.calls).toHaveLength(2);
      expect(world.local.calls.map((request) => request.tools)).toEqual([[], []]);
      expect(world.cloud.calls).toHaveLength(0);
    } finally {
      await reopened.close();
    }
  });

  it("uses a refreshed default for a conversation opened before setup", async () => {
    const world = await modelWorld();
    try {
      const id = await world.creature("Pip");
      world.nextDefault(world.local);
      const report = await world.host.models?.refresh?.();
      expect(report).toMatchObject({ inherits: { strong: localChoice } });
      await world.host.prompt(id, "hello after setup");
      await world.settled(id);
      expect(world.local.calls).toHaveLength(1);
      expect(world.cloud.calls).toHaveLength(0);
    } finally {
      await world.host.close?.();
    }
  });

  it("keeps an active turn and its selected conversation bound across refresh", async () => {
    const release = Promise.withResolvers<void>();
    const world = await modelWorld({ cloudWait: release.promise });
    try {
      const id = await world.creature("Pip");
      await world.host.prompt(id, "first");
      await vi.waitFor(() => expect(world.cloud.calls).toHaveLength(1));
      world.nextDefault(world.local);
      await world.host.models?.refresh?.();
      expect((await world.host.list()).find((session) => session.id === id)?.working).toBe(true);
      release.resolve();
      await world.settled(id);
      await world.host.prompt(id, "second");
      await world.settled(id);
      expect(world.cloud.calls).toHaveLength(2);
      const later = await world.creature("Wren");
      await world.host.prompt(later, "new conversation");
      await world.settled(later);
      expect(world.local.calls).toHaveLength(1);
    } finally {
      release.resolve();
      await world.host.close?.();
    }
  });

  it("never reopens a saved local conversation on the cloud when its connection is gone", async () => {
    const world = await modelWorld();
    const id = await world.creature("Pip", localChoice);
    await world.host.prompt(id, "private first turn");
    await world.settled(id);
    await world.host.close();
    world.disableLocal();
    const reopened = await world.reopen();
    try {
      await reopened.prompt(id, "still private");
      await vi.waitFor(async () =>
        expect((await reopened.list()).find((session) => session.id === id)?.working).toBe(false),
      );
      expect(world.local.calls).toHaveLength(1);
      expect(world.cloud.calls).toHaveLength(0);
      expect((await findSession(world.sessionDir, id))?.modelSelection()).toMatchObject({
        provider: "local",
        modelId: "local-model",
      });
    } finally {
      await reopened.close();
    }
  });
});

const localChoice: ModelReference = { provider: "local", model: "local-model" };

async function modelWorld(
  options: { localContext?: number; cloudWait?: Promise<void>; projectTrusted?: boolean } = {},
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 503 })),
  );
  const cwd = await tempDir();
  const sessionDir = await tempDir();
  const userRoot = await tempDir();
  await mkdir(join(cwd, ".keywork", "memory"), { recursive: true });
  await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "models" }));
  const cloud = recordedProvider("cloud", "cloud-model", options.cloudWait);
  const local = recordedProvider("local", "local-model");
  let current: Provider = cloud;
  let next: Provider = cloud;
  const registry = new InferenceRegistry();
  registry.register(registration(cloud, "https://cloud.invalid/v1"));
  registry.register(registration(local, "http://127.0.0.1:11434/v1"));
  const capabilities = new CapabilityCache();
  capabilities.store({
    ...blankRecord(
      "http://127.0.0.1:11434",
      "local-model",
      {
        id: "local-server",
        kind: "ollama",
        version: "test",
        build: null,
        routes: ["/api/show"],
      },
      "2026-11-10T00:00:00Z",
    ),
    tools: known(true, { source: "behaviour-probe", probe: "fixture" }),
    contextAllocated: known(options.localContext ?? 131_072, {
      source: "native-route",
      route: "/api/show",
    }),
  });
  const provider = (name: string): Provider => (name === "local" ? local : cloud);
  const hosting: ServedHostOptions = {
    cwd,
    sessionDir,
    userRoot,
    projectTrusted: options.projectTrusted ?? true,
    provider: cloud,
    currentProvider: () => current,
    refreshInference: async () => {
      current = next;
    },
    inference: {
      bind: (reference) => registry.bind(reference),
      provider: (binding) => provider(binding.reference.provider),
    },
    inventory: {
      capabilities,
      registrations: () => registry.all(),
      provider: (binding) => provider(binding.reference.provider),
      decider: () => {
        throw new Error("no decider in this fixture");
      },
    },
    modelProbe: {
      get: async () => ({ status: 404, ok: false, body: {}, text: "" }),
      post: async () => ({ status: 404, ok: false, body: {}, text: "" }),
    },
    permissions: () => "deny",
    checkpoints: "off",
    log: new EventLog(),
  };
  const host = await servedHost(hosting);
  const creatures = host.creatures as CreatureHost;
  return {
    host,
    creatures,
    cloud,
    local,
    sessionDir,
    reopen: () => servedHost(hosting),
    disableLocal: () =>
      registry.register({ ...registration(local, "http://127.0.0.1:11434/v1"), enabled: false }),
    nextDefault: (replacement: Provider) => {
      next = replacement;
    },
    creature: async (name: string, choice?: ModelReference) => {
      const creature = await creatures.create({
        name,
        ...(choice !== undefined && { models: { strong: choice } }),
      });
      const detail = await creatures.read(creature.slug);
      if (detail === undefined) throw new Error("creature missing");
      return detail.conversation;
    },
    settled: (id: string) =>
      vi.waitFor(async () =>
        expect((await host.list()).find((session) => session.id === id)?.working).toBe(false),
      ),
  };
}

function recordedProvider(name: string, modelId: string, wait?: Promise<void>) {
  const calls: ProviderRequest[] = [];
  return {
    name,
    modelId,
    calls,
    async *stream(request: ProviderRequest) {
      calls.push(request);
      await wait;
      yield { type: "text" as const, text: `hello from ${name}` };
      yield { type: "done" as const, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

function registration(provider: Provider, endpoint: string): ProviderRegistration {
  return {
    name: provider.name,
    protocol: "chat-completions",
    endpoint,
    credential: { kind: "none" },
    models: [{ id: provider.modelId ?? "model", origin: "declared" }],
    openCatalog: false,
    enabled: true,
  };
}

function reply(body: unknown) {
  return { status: 200, ok: true, body, text: JSON.stringify(body) };
}
