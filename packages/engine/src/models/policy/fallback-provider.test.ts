import { describe, expect, it } from "vitest";
import type { ProviderRegistration } from "../../inference/types.ts";
import type { Provider, ProviderRequest, TurnDelta } from "../../provider.ts";
import { ProviderHttpError } from "../../providers/errors.ts";
import { blankRecord } from "../capabilities/index.ts";
import {
  type FallbackSwitch,
  fallbackProvider,
  localityOf,
  type PlannedCandidate,
  type PolicyPlan,
} from "./index.ts";

type Step = TurnDelta | Error;

function scripted(name: string, steps: readonly Step[]): Provider {
  return {
    name,
    modelId: `${name}-model`,
    stream: (): AsyncIterable<TurnDelta> =>
      (async function* () {
        for (const step of steps) {
          if (step instanceof Error) throw step;
          yield step;
        }
      })(),
  };
}

const done: TurnDelta = { type: "done", usage: { inputTokens: 10, outputTokens: 2 } };
const saturated = new ProviderHttpError("ollama", 503, "server busy");
const request: ProviderRequest = { systemPrompt: "", messages: [], tools: [] };

const plan: PolicyPlan = {
  modelClass: "loop",
  candidates: [
    planned("ollama", "http://localhost:11434/v1"),
    planned("spark", "http://100.88.12.4:9931/v1"),
    planned("openrouter", "https://openrouter.ai/api/v1"),
  ],
  refused: [],
  localOnly: true,
};

async function collect(provider: Provider, signal?: AbortSignal): Promise<TurnDelta[]> {
  const deltas: TurnDelta[] = [];
  for await (const delta of provider.stream({ ...request, ...(signal && { signal }) })) {
    deltas.push(delta);
  }
  return deltas;
}

function harness(scripts: Record<string, readonly Step[]>) {
  const opened: string[] = [];
  const switches: FallbackSwitch[] = [];
  const provider = fallbackProvider({
    plan,
    open: (candidate) => {
      const name = candidate.binding.reference.provider;
      opened.push(name);
      return scripted(name, scripts[name] ?? []);
    },
    onFallback: (event) => switches.push(event),
  });
  return { provider, opened, switches };
}

describe("fallbackProvider", () => {
  it("presents the primary candidate's identity", () => {
    const { provider } = harness({});
    expect([provider.name, provider.modelId]).toEqual(["ollama", "ollama-model"]);
  });

  it("moves to the next candidate when the first fails before streaming anything", async () => {
    const { provider, opened, switches } = harness({
      ollama: [saturated],
      spark: [{ type: "text", text: "from spark" }, done],
    });
    expect(await collect(provider)).toEqual([{ type: "text", text: "from spark" }, done]);
    expect(opened).toEqual(["ollama", "spark"]);
    expect(switches.map(({ trigger, cloudFallback }) => [trigger, cloudFallback])).toEqual([
      ["saturated", undefined],
    ]);
  });

  it("reports the step that leaves the creature's machines for the cloud", async () => {
    const { provider, switches } = harness({
      ollama: [saturated],
      spark: [new ProviderHttpError("spark", 429, "slow down")],
      openrouter: [done],
    });
    await collect(provider);
    expect(switches.at(-1)?.cloudFallback).toEqual({
      from: { provider: "spark", model: "m" },
      to: { provider: "openrouter", model: "m" },
      trigger: "rate-limited",
    });
  });

  it("rethrows once a tool call was streamed", async () => {
    const call = { type: "tool-call", callId: "c1", name: "bash", arguments: {} } as const;
    const { provider, opened } = harness({
      ollama: [{ type: "tool-call", call }, saturated],
    });
    await expect(collect(provider)).rejects.toBe(saturated);
    expect(opened).toEqual(["ollama"]);
  });

  it("rethrows once text was streamed", async () => {
    const { provider, opened } = harness({ ollama: [{ type: "text", text: "half" }, saturated] });
    await expect(collect(provider)).rejects.toBe(saturated);
    expect(opened).toEqual(["ollama"]);
  });

  it("rethrows model-not-found without trying another model", async () => {
    const missing = new ProviderHttpError("ollama", 404, '{"error":"model not found"}');
    const { provider, opened } = harness({ ollama: [missing] });
    await expect(collect(provider)).rejects.toBe(missing);
    expect(opened).toEqual(["ollama"]);
  });

  it("rethrows when the caller aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { provider, opened } = harness({ ollama: [new Error("aborted")] });
    await expect(collect(provider, controller.signal)).rejects.toThrow("aborted");
    expect(opened).toEqual(["ollama"]);
  });

  it("rethrows the last failure when every candidate failed", async () => {
    const last = new ProviderHttpError("openrouter", 503, "down");
    const { provider, opened } = harness({
      ollama: [saturated],
      spark: [saturated],
      openrouter: [last],
    });
    await expect(collect(provider)).rejects.toBe(last);
    expect(opened).toEqual(["ollama", "spark", "openrouter"]);
  });
});

function planned(name: string, endpoint: string): PlannedCandidate {
  const registration: ProviderRegistration = {
    name,
    protocol: "chat-completions",
    endpoint,
    credential: { kind: "none" },
    models: [],
    openCatalog: true,
    enabled: true,
  };
  const server = { id: name, kind: "ollama", version: null, build: null, routes: [] } as const;
  return {
    level: "creature",
    locality: localityOf(endpoint),
    capabilities: blankRecord(endpoint, "m", server, "2026-11-05"),
    binding: {
      reference: { provider: name, model: "m" },
      registration,
      spec: { id: "m", origin: "unlisted" },
      protocol: "chat-completions",
      capabilities: { input: ["text"], toolCalls: true },
      credential: undefined,
    },
  };
}
