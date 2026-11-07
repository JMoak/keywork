import { describe, expect, it } from "vitest";
import type { InferenceBinding, ProviderRegistration } from "../../inference/types.ts";
import { blankRecord, type CapabilityRecord, known } from "../capabilities/index.ts";
import { inheritedClasses, type PolicyEnvironment } from "./index.ts";

const now = () => new Date("2026-11-06T12:00:00Z");

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

const openai = registration("openai", "https://api.openai.com/v1", {
  models: [
    {
      id: "gpt-5",
      origin: "declared",
      capabilities: { input: ["text", "image"], toolCalls: true, contextWindow: 400_000 },
    },
  ],
});
const openrouter = registration("openrouter", "https://openrouter.ai/api/v1", {
  defaultModel: "openai/gpt-5-mini",
  capabilityDeclarations: {
    "small/*": { contextWindow: 32_768, toolCalls: true },
    "blind/*": { input: ["text"] },
  },
});
const keyless = registration("keyless", "https://llm.example.com/v1", {
  credential: { kind: "missing", expected: "KEYLESS_API_KEY" },
});
const spark = registration("spark", "http://100.88.12.4:9931/v1", {
  credential: { kind: "none" },
  insecureTransport: true,
});

function environment(overrides: Partial<PolicyEnvironment> = {}): PolicyEnvironment {
  return { registrations: [openai, openrouter, keyless, spark], now, ...overrides };
}

describe("inheritedClasses", () => {
  it("names the host's cloud default for strong, loop and vision, and decides through the built-in decider", () => {
    const inherits = inheritedClasses({ provider: "openai", model: "gpt-5" }, environment());

    expect(inherits.strong).toEqual({ provider: "openai", model: "gpt-5" });
    expect(inherits.loop).toEqual({ provider: "openai", model: "gpt-5" });
    expect(inherits.vision).toEqual({ provider: "openai", model: "gpt-5" });
    expect(inherits.decide).toEqual({
      provider: "openai",
      model: "gpt-5",
      decider: "builtin",
      detail:
        "openai/gpt-5 has no decision endpoint or logprobs, so the built-in decider asks it each question",
    });
  });

  it("resolves keywork's OpenRouter default in every class though nothing about it was measured", () => {
    const inherits = inheritedClasses(
      { provider: "openrouter", model: "openai/gpt-5-mini" },
      environment(),
    );

    const gpt = { provider: "openrouter", model: "openai/gpt-5-mini" };
    expect(inherits.strong).toEqual(gpt);
    expect(inherits.loop).toEqual(gpt);
    expect(inherits.vision).toEqual(gpt);
    expect(inherits.decide).toMatchObject({ ...gpt, decider: "builtin" });
  });

  it("refuses a cloud default only on a declared shortfall, naming the measurement and the model", () => {
    const small = inheritedClasses({ provider: "openrouter", model: "small/m" }, environment());
    expect(small.strong).toEqual({
      refused: "missing-capability",
      detail:
        "openrouter/small/m cannot serve the strong class: 32768 tokens of context allocated, and it needs at least 131072 tokens of context allocated",
    });
    expect(small.loop).toMatchObject({ refused: "missing-capability" });
    expect(small.vision).toEqual({ provider: "openrouter", model: "small/m" });

    const blind = inheritedClasses({ provider: "openrouter", model: "blind/m" }, environment());
    expect(blind.strong).toEqual({ provider: "openrouter", model: "blind/m" });
    expect(blind.vision).toEqual({
      refused: "missing-capability",
      detail:
        "openrouter/blind/m cannot serve the vision class: it declares no image input, and it needs image input",
    });
  });

  it("refuses every class when the host has no default", () => {
    const inherits = inheritedClasses(undefined, environment());
    expect(Object.values(inherits)).toEqual(
      Array(4).fill({
        refused: "unconfigured",
        detail: "this host has no default model to inherit",
      }),
    );
  });

  it("carries the resolver's own failure code for a default that cannot bind", () => {
    expect(inheritedClasses({ provider: "keyless", model: "m" }, environment()).strong).toEqual({
      refused: "unavailable-credential",
      detail: expect.any(String),
    });
    expect(inheritedClasses({ provider: "gone", model: "m" }, environment()).strong).toEqual({
      refused: "unknown-provider",
      detail: expect.any(String),
    });
  });

  it("judges a class by the probed record when the host has one", () => {
    const probed = (binding: InferenceBinding): CapabilityRecord => ({
      ...blankRecord(binding.registration.endpoint, binding.reference.model, server, "2026-11-06"),
      tools: known(true, measured),
      contextAllocated: known(131_072, measured),
      decodeTokensPerSecond: known(61.5, measured),
    });

    const inherits = inheritedClasses(
      { provider: "spark", model: "qwen3.8:27b" },
      environment({ capabilityOf: probed }),
    );

    expect(inherits.strong).toEqual({ provider: "spark", model: "qwen3.8:27b" });
    expect(inherits.loop).toEqual({ provider: "spark", model: "qwen3.8:27b" });
    expect(inherits.vision).toMatchObject({ refused: "missing-capability" });
    expect(inherits.decide).toEqual({
      refused: "missing-capability",
      detail:
        "spark/qwen3.8:27b cannot serve the decide class: no decision endpoint or logprobs was found, and it needs a decision endpoint or logprobs",
    });
  });

  it("carries a refusal the host adds on top of capabilities, such as an unacknowledged license", () => {
    const inherits = inheritedClasses(
      { provider: "openai", model: "gpt-5" },
      environment({
        refusalOf: (binding) => ({
          code: "missing-capability",
          reference: "openai/gpt-5",
          model: binding.reference.model,
          capability: "license-acknowledgement",
          message: "gpt-5 needs its license acknowledged",
        }),
      }),
    );
    expect(inherits.strong).toEqual({
      refused: "missing-capability",
      detail: "gpt-5 needs its license acknowledged",
    });
  });
});

const server = {
  id: "fp",
  kind: "llama-server",
  version: "b12122",
  build: null,
  routes: [],
} as const;

const measured = { source: "measured", at: "2026-11-06" } as const;
