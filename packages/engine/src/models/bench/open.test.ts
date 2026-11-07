import { afterEach, describe, expect, it } from "vitest";
import type { InferenceBinding, ProviderRegistration } from "../../inference/types.ts";
import type { Provider } from "../../provider.ts";
import { probeHttp } from "../adapters/http.ts";
import { FixtureServer, loadFixture } from "../adapters/testing/fixture-server.ts";
import { CapabilityCache, probeServer } from "../capabilities/index.ts";
import type { Decider } from "../decide/types.ts";
import { benchBook, localBenchOpener, registryBenchOpener } from "./index.ts";

const servers: FixtureServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function started(server: FixtureServer): Promise<string> {
  servers.push(server);
  return server.listen();
}

const now = () => new Date("2026-11-05T12:00:00.000Z");
const http = probeHttp({ timeoutMs: 2_000 });

function steppingClock(stepMs: number): () => number {
  let at = 0;
  return () => {
    at += stepMs;
    return at;
  };
}

describe("localBenchOpener", () => {
  it("leaves cloud endpoints to another opener", async () => {
    const open = localBenchOpener({ cache: new CapabilityCache(now), http, now });
    expect(await open({ endpoint: "https://api.openai.com/v1", model: "gpt-5" })).toBeUndefined();
  });

  it("refuses an unreachable endpoint, a /v1/models-only server and a model it lacks", async () => {
    const open = localBenchOpener({ cache: new CapabilityCache(now), http, now });
    expect(await open({ endpoint: "http://127.0.0.1:1", model: "qwen3.8:27b" })).toMatchObject({
      ok: false,
      refused: "unreachable",
    });
    const listedOnly = await started(
      new FixtureServer().route("GET /v1/models", { body: { data: [{ id: "anything" }] } }),
    );
    expect(await open({ endpoint: listedOnly, model: "anything" })).toMatchObject({
      ok: false,
      refused: "unrecognized",
    });
    const ollama = await started(new FixtureServer(loadFixture("ollama-0.40.14")));
    expect(await open({ endpoint: ollama, model: "absent:7b" })).toEqual({
      ok: false,
      refused: "missing",
      error: `${ollama} does not serve absent:7b`,
    });
  });

  it("benches a served model and writes the measured decode into its record", async () => {
    const cache = new CapabilityCache(now);
    const ollama = await started(new FixtureServer(loadFixture("ollama-0.40.14")));
    await probeServer(ollama, { http, cache, now, models: ["qwen3.8:27b"] });
    expect(cache.record(ollama, "qwen3.8:27b")?.decodeTokensPerSecond.known).toBe(false);
    const book = benchBook({
      openers: [localBenchOpener({ cache, http, now })],
      clock: steppingClock(250),
      now,
    });
    const outcome = await book.run({ endpoint: `${ollama}/v1`, model: "qwen3.8:27b" });
    if (!("report" in outcome)) throw new Error(outcome.error);
    expect(outcome.report).toMatchObject({
      kind: "chat",
      reference: "ollama/qwen3.8:27b",
      fingerprint: { kind: "ollama", version: "0.40.14" },
      repeats: 3,
    });
    const measured = outcome.report.kind === "chat" ? outcome.report.decodeTokensPerSecond : null;
    expect(measured).not.toBeNull();
    expect(cache.record(ollama, "qwen3.8:27b")?.decodeTokensPerSecond).toEqual({
      known: true,
      value: measured?.mean,
      evidence: { source: "measured", at: "2026-11-05T12:00:00.000Z" },
    });
  });
});

function registration(
  name: string,
  endpoint: string,
  overrides: Partial<ProviderRegistration> = {},
): ProviderRegistration {
  return {
    name,
    protocol: "chat-completions",
    endpoint,
    credential: { kind: "present", handle: { id: name, label: `${name.toUpperCase()}_API_KEY` } },
    models: [],
    openCatalog: true,
    enabled: true,
    ...overrides,
  };
}

const registrations = [
  registration("openai", "https://api.openai.com/v1"),
  registration("openrouter", "https://openrouter.ai/api/v1"),
  registration("parked", "https://llm.example.com/v1", { enabled: false }),
];

function standInProvider(binding: InferenceBinding): Provider {
  return {
    name: binding.registration.name,
    modelId: binding.reference.model,
    stream: async function* () {},
  };
}

function standInDecider(binding: InferenceBinding): Decider {
  return {
    reference: binding.reference,
    decide: async () => ({ ok: false, failure: { reason: "refused", message: "stand-in" } }),
  };
}

describe("registryBenchOpener", () => {
  const bound: string[] = [];
  const open = registryBenchOpener({
    registrations: () => registrations,
    provider: (binding) => {
      bound.push(`${binding.reference.provider}/${binding.reference.model}`);
      return standInProvider(binding);
    },
    decider: standInDecider,
  });

  it("claims only endpoints a registration names", async () => {
    expect(
      await open({ endpoint: "http://127.0.0.1:11434", model: "qwen3.8:27b" }),
    ).toBeUndefined();
  });

  it("opens a chat model through the registry with its declared fingerprint", async () => {
    const opened = await open({ endpoint: "https://api.openai.com/v1/", model: "gpt-5" });
    expect(opened).toMatchObject({
      ok: true,
      reference: "openai/gpt-5",
      fingerprint: { id: "declared:openai", kind: "openai-compatible" },
      subject: { kind: "chat" },
    });
    expect(bound).toContain("openai/gpt-5");
  });

  it("opens a hosted decision model as a decider", async () => {
    const opened = await open({
      endpoint: "https://openrouter.ai/api/v1",
      model: "typesafe/jev-1.14",
    });
    expect(opened).toMatchObject({
      ok: true,
      reference: "openrouter/typesafe/jev-1.14",
      subject: { kind: "decide" },
    });
    const chatOnly = registryBenchOpener({
      registrations: () => registrations,
      provider: standInProvider,
    });
    expect(
      await chatOnly({ endpoint: "https://openrouter.ai/api/v1", model: "typesafe/jev-1.14" }),
    ).toMatchObject({ ok: true, subject: { kind: "chat" } });
  });

  it("refuses what the registry cannot bind or open", async () => {
    expect(await open({ endpoint: "https://llm.example.com/v1", model: "big" })).toMatchObject({
      ok: false,
      refused: "missing",
      error: expect.stringContaining("disabled"),
    });
    const broken = registryBenchOpener({
      registrations: () => registrations,
      provider: () => {
        throw new Error("no transport for openai");
      },
    });
    expect(await broken({ endpoint: "https://api.openai.com/v1", model: "gpt-5" })).toEqual({
      ok: false,
      refused: "failed",
      error: "no transport for openai",
    });
  });
});
