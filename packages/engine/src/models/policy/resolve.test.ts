import { describe, expect, it } from "vitest";
import type {
  InferenceBinding,
  Protocol,
  ProviderRegistration,
  ResolutionFailureCode,
} from "../../inference/types.ts";
import { blankRecord, type CapabilityRecord, known } from "../capabilities/index.ts";
import {
  type ModelCandidate,
  type PolicyEnvironment,
  type PolicyLevels,
  type PolicyResolution,
  resolvePolicy,
} from "./index.ts";

const probed = { source: "native-route", route: "/props" } as const;
const fixedNow = () => new Date("2026-11-05T12:00:00Z");

function registration(
  name: string,
  endpoint: string,
  overrides: Partial<ProviderRegistration> = {},
): ProviderRegistration {
  return {
    name,
    protocol: "chat-completions",
    endpoint,
    credential: { kind: "none" },
    models: [],
    openCatalog: true,
    enabled: true,
    ...overrides,
  };
}

const ollama = registration("ollama", "http://localhost:11434/v1");
const spark = registration("spark", "http://100.88.12.4:9931/v1", { insecureTransport: true });
const openrouter = registration("openrouter", "https://openrouter.ai/api/v1", {
  credential: { kind: "present", handle: { id: "openrouter", label: "OPENROUTER_API_KEY" } },
});

function record(
  binding: InferenceBinding,
  facts: Partial<Omit<CapabilityRecord, "endpoint" | "model" | "server" | "probedAt">>,
): CapabilityRecord {
  const server = {
    id: "fp",
    kind: "llama-server",
    version: "b12122",
    build: null,
    routes: [],
  } as const;
  return {
    ...blankRecord(binding.registration.endpoint, binding.reference.model, server, "2026-11-05"),
    ...facts,
  } as CapabilityRecord;
}

const strongFacts = {
  tools: known(true, probed),
  contextAllocated: known(262_144, probed),
  imageInput: known("base64" as const, probed),
};

const loopFacts = {
  tools: known(true, probed),
  contextAllocated: known(131_072, probed),
  decodeTokensPerSecond: known(76.9, { source: "measured", at: "2026-11-05" } as const),
};

const decideFacts = { decisionEndpoint: known("/v1/systemone" as const, probed) };

function probedEnvironment(
  registrations: readonly ProviderRegistration[],
  facts: Record<string, Parameters<typeof record>[1]>,
): PolicyEnvironment {
  return {
    registrations,
    now: fixedNow,
    capabilityOf: (binding) => {
      const found = facts[`${binding.reference.provider}/${binding.reference.model}`];
      return found === undefined ? undefined : record(binding, found);
    },
  };
}

function slot(provider: string, model: string): ModelCandidate {
  return { provider, model };
}

function planOf(resolution: PolicyResolution) {
  if (!resolution.ok || resolution.kind !== "plan") {
    throw new Error(`expected a plan, got ${JSON.stringify(resolution)}`);
  }
  return resolution.plan;
}

function failureOf(resolution: PolicyResolution) {
  if (resolution.ok) throw new Error(`expected a failure, got ${JSON.stringify(resolution)}`);
  return resolution;
}

function referencesOf(resolution: PolicyResolution): string[] {
  return planOf(resolution).candidates.map(
    ({ binding }) => `${binding.reference.provider}/${binding.reference.model}`,
  );
}

const everyoneStrong = probedEnvironment([ollama, spark, openrouter], {
  "ollama/qwen3.8-27b": strongFacts,
  "spark/qwen3.8-flash-next": strongFacts,
  "openrouter/qwen/qwen3.8-27b": strongFacts,
});

describe("resolvePolicy across the three levels", () => {
  const creature: PolicyLevels["creature"] = { strong: slot("ollama", "qwen3.8-27b") };
  const workspace: PolicyLevels["workspace"] = { strong: slot("spark", "qwen3.8-flash-next") };
  const user: PolicyLevels["user"] = { strong: slot("openrouter", "qwen/qwen3.8-27b") };

  it("inherits everywhere by default, leaving the caller on its ordinary model", () => {
    const resolution = resolvePolicy(
      { modelClass: "strong", levels: { creature: { strong: "inherit" }, workspace: {} } },
      everyoneStrong,
    );
    expect(resolution).toEqual({ ok: true, kind: "inherit", modelClass: "strong" });
  });

  it("takes the creature's choice first when it names one", () => {
    const resolution = resolvePolicy(
      { modelClass: "strong", levels: { creature, workspace, user }, cloudFallback: true },
      everyoneStrong,
    );
    expect(referencesOf(resolution)).toEqual([
      "ollama/qwen3.8-27b",
      "spark/qwen3.8-flash-next",
      "openrouter/qwen/qwen3.8-27b",
    ]);
    expect(planOf(resolution).candidates.map((candidate) => candidate.level)).toEqual([
      "creature",
      "workspace",
      "user",
    ]);
  });

  it("falls to the workspace when the creature inherits", () => {
    const resolution = resolvePolicy(
      { modelClass: "strong", levels: { creature: { strong: "inherit" }, workspace, user } },
      everyoneStrong,
    );
    expect(planOf(resolution).candidates[0].level).toBe("workspace");
  });

  it("falls to the user when the creature and the workspace inherit", () => {
    const resolution = resolvePolicy(
      { modelClass: "strong", levels: { creature: {}, workspace: {}, user } },
      everyoneStrong,
    );
    expect(referencesOf(resolution)).toEqual(["openrouter/qwen/qwen3.8-27b"]);
    expect(planOf(resolution).localOnly).toBe(false);
  });

  it("collapses a candidate repeated at an outer level into its nearest mention", () => {
    const resolution = resolvePolicy(
      { modelClass: "strong", levels: { creature, workspace: creature, user: creature } },
      everyoneStrong,
    );
    expect(planOf(resolution).candidates).toHaveLength(1);
  });

  it("resolves each class from its own slot", () => {
    const environment = probedEnvironment([ollama], {
      "ollama/qwen3.6-35b-a3b": loopFacts,
      "ollama/nimble": decideFacts,
      "ollama/qwen3.8-27b": strongFacts,
    });
    const levels: PolicyLevels = {
      creature: {
        strong: slot("ollama", "qwen3.8-27b"),
        loop: slot("ollama", "qwen3.6-35b-a3b"),
        decide: slot("ollama", "nimble"),
        vision: slot("ollama", "qwen3.8-27b"),
      },
    };
    expect(referencesOf(resolvePolicy({ modelClass: "loop", levels }, environment))).toEqual([
      "ollama/qwen3.6-35b-a3b",
    ]);
    expect(referencesOf(resolvePolicy({ modelClass: "decide", levels }, environment))).toEqual([
      "ollama/nimble",
    ]);
    expect(referencesOf(resolvePolicy({ modelClass: "vision", levels }, environment))).toEqual([
      "ollama/qwen3.8-27b",
    ]);
  });
});

describe("resolvePolicy refuses candidates at resolution", () => {
  function refusedCode(
    registrations: readonly ProviderRegistration[],
    modelClass: "strong" | "loop" | "decide" | "vision",
    candidate: { provider: string; model: string },
    facts: Record<string, Parameters<typeof record>[1]> = {},
  ): ResolutionFailureCode {
    const resolution = resolvePolicy(
      { modelClass, levels: { creature: { [modelClass]: candidate } } },
      probedEnvironment(registrations, facts),
    );
    return failureOf(resolution).failure.code;
  }

  it("names a provider nobody registered unknown-provider", () => {
    expect(refusedCode([ollama], "strong", slot("lmstudio", "qwen3.8-27b"))).toBe(
      "unknown-provider",
    );
  });

  it("names a model a closed catalog does not list unknown-model", () => {
    const closed = registration("closed", "http://localhost:8080/v1", {
      openCatalog: false,
      models: [{ id: "gpt-oss-120b", origin: "declared" }],
    });
    expect(refusedCode([closed], "strong", slot("closed", "qwen3.8-27b"))).toBe("unknown-model");
  });

  it("refuses a disabled provider in every class", () => {
    const off = registration("off", "http://localhost:11434/v1", { enabled: false });
    expect(refusedCode([off], "strong", slot("off", "qwen3.8-27b"))).toBe("disabled-provider");
    expect(refusedCode([off], "decide", slot("off", "nimble"))).toBe("disabled-provider");
  });

  it("refuses a provider whose credential is missing", () => {
    const keyless = registration("openrouter", "https://openrouter.ai/api/v1", {
      credential: { kind: "missing", expected: "OPENROUTER_API_KEY" },
    });
    expect(refusedCode([keyless], "strong", slot("openrouter", "x"))).toBe(
      "unavailable-credential",
    );
    expect(refusedCode([keyless], "decide", slot("openrouter", "typesafe/jev-1.14"))).toBe(
      "unavailable-credential",
    );
  });

  it("refuses a model declared on a protocol keywork does not speak", () => {
    const odd = registration("odd", "http://localhost:8000/v1", {
      openCatalog: false,
      models: [{ id: "m", origin: "declared", protocol: "grpc" as Protocol }],
    });
    expect(refusedCode([odd], "strong", slot("odd", "m"))).toBe("unsupported-protocol");
  });

  it("refuses plain HTTP off loopback without the insecure-transport opt-in", () => {
    const remote = registration("remote", "http://192.168.1.20:11434/v1");
    expect(refusedCode([remote], "strong", slot("remote", "m"))).toBe("insecure-endpoint");
    expect(refusedCode([remote], "decide", slot("remote", "nimble"))).toBe("insecure-endpoint");
  });

  it("refuses a strong candidate whose allocated context is under 128K", () => {
    const small = { ...strongFacts, contextAllocated: known(32_768, probed) };
    const resolution = resolvePolicy(
      { modelClass: "strong", levels: { creature: { strong: slot("ollama", "qwen3.8-27b") } } },
      probedEnvironment([ollama], { "ollama/qwen3.8-27b": small }),
    );
    expect(failureOf(resolution).failure).toMatchObject({
      code: "missing-capability",
      reference: "ollama/qwen3.8-27b",
      model: "qwen3.8-27b",
      capability: "contextAllocated",
    });
  });

  it("refuses a loop candidate whose decode speed was never measured on its node", () => {
    const unmeasured = { tools: known(true, probed), contextAllocated: known(131_072, probed) };
    expect(
      refusedCode([ollama], "loop", slot("ollama", "qwen3.6-35b-a3b"), {
        "ollama/qwen3.6-35b-a3b": unmeasured,
      }),
    ).toBe("missing-capability");
  });

  it("refuses a vision candidate without image input", () => {
    const blind = { ...strongFacts, imageInput: known("none" as const, probed) };
    expect(
      refusedCode([ollama], "vision", slot("ollama", "flint"), { "ollama/flint": blind }),
    ).toBe("missing-capability");
  });

  it("refuses a decide candidate with neither a decision endpoint nor logprobs", () => {
    expect(refusedCode([ollama], "decide", slot("ollama", "qwen3.8-27b"))).toBe(
      "missing-capability",
    );
  });

  it("judges an unprobed chat model by its declarations", () => {
    const declared = registration("declared", "http://localhost:8080/v1", {
      capabilityDeclarations: { "big-*": { contextWindow: 262_144, toolCalls: true } },
    });
    const environment: PolicyEnvironment = { registrations: [declared], now: fixedNow };
    const resolution = resolvePolicy(
      { modelClass: "strong", levels: { user: { strong: slot("declared", "big-model") } } },
      environment,
    );
    expect(planOf(resolution).candidates[0].capabilities.contextAllocated).toEqual({
      known: true,
      value: 262_144,
      evidence: { source: "declared" },
    });
    const unknown = resolvePolicy(
      { modelClass: "strong", levels: { user: { strong: slot("declared", "small") } } },
      environment,
    );
    expect(failureOf(unknown).failure.code).toBe("missing-capability");
  });

  it("never asks a decision model for tool calls", () => {
    const declaredWithoutTools = registration("ollama", "http://localhost:11434/v1", {
      capabilityDeclarations: { nimble: { toolCalls: false } },
    });
    const resolution = resolvePolicy(
      { modelClass: "decide", levels: { creature: { decide: slot("ollama", "nimble") } } },
      probedEnvironment([declaredWithoutTools], { "ollama/nimble": decideFacts }),
    );
    expect(referencesOf(resolution)).toEqual(["ollama/nimble"]);
  });

  it("knows the hosted Jev models are decision models without a probe", () => {
    const resolution = resolvePolicy(
      {
        modelClass: "decide",
        levels: { user: { decide: slot("openrouter", "typesafe/jev-1.14") } },
      },
      { registrations: [openrouter], now: fixedNow },
    );
    const [jev] = planOf(resolution).candidates;
    expect(jev.binding.credential).toEqual({ id: "openrouter", label: "OPENROUTER_API_KEY" });
    expect(jev.capabilities.decisionEndpoint).toMatchObject({
      known: true,
      value: "/v1/systemone",
    });
  });

  it("falls past a refused nearer candidate and reports why it was refused", () => {
    const resolution = resolvePolicy(
      {
        modelClass: "strong",
        levels: {
          creature: { strong: slot("lmstudio", "qwen3.8-27b") },
          workspace: { strong: slot("ollama", "qwen3.8-27b") },
        },
      },
      everyoneStrong,
    );
    const plan = planOf(resolution);
    expect(plan.candidates[0].level).toBe("workspace");
    expect(plan.refused).toMatchObject([
      { level: "creature", reason: "unresolved", failure: { code: "unknown-provider" } },
    ]);
  });

  it("fails with the nearest refusal when no candidate resolves", () => {
    const resolution = resolvePolicy(
      {
        modelClass: "strong",
        levels: {
          creature: { strong: slot("lmstudio", "a") },
          user: { strong: slot("vllm", "b") },
        },
      },
      everyoneStrong,
    );
    const failure = failureOf(resolution);
    expect(failure.level).toBe("creature");
    expect(failure.failure).toMatchObject({ reference: "lmstudio/a" });
    expect(failure.refused).toHaveLength(2);
  });

  it("is never ambiguous, because a policy candidate always names its provider", () => {
    const resolution = resolvePolicy(
      { modelClass: "strong", levels: { creature: { strong: slot("spark", "qwen3.8-27b") } } },
      probedEnvironment([ollama, spark], { "spark/qwen3.8-27b": strongFacts }),
    );
    expect(referencesOf(resolution)).toEqual(["spark/qwen3.8-27b"]);
  });

  it("is never unconfigured, because a policy that names nothing inherits", () => {
    const resolution = resolvePolicy(
      { modelClass: "decide", levels: {} },
      { registrations: [], now: fixedNow },
    );
    expect(resolution).toEqual({ ok: true, kind: "inherit", modelClass: "decide" });
  });
});

describe("resolvePolicy judges a cloud model by declared facts, never by what only a mill measures", () => {
  const catalogued = registration("openrouter", "https://openrouter.ai/api/v1", {
    credential: { kind: "present", handle: { id: "openrouter", label: "OPENROUTER_API_KEY" } },
    capabilityDeclarations: {
      "openai/*": { input: ["text", "image"], contextWindow: 400_000 },
      "tiny/*": { input: ["text"], contextWindow: 32_768 },
    },
  });
  const environment: PolicyEnvironment = { registrations: [catalogued], now: fixedNow };
  const resolve = (modelClass: "strong" | "loop" | "decide" | "vision", model: string) =>
    resolvePolicy(
      { modelClass, levels: { user: { [modelClass]: slot("openrouter", model) } } },
      environment,
    );

  it("resolves strong and loop for a cloud model whose context and decode were never measured", () => {
    expect(referencesOf(resolve("strong", "mystery/m"))).toEqual(["openrouter/mystery/m"]);
    expect(referencesOf(resolve("loop", "mystery/m"))).toEqual(["openrouter/mystery/m"]);
    expect(
      planOf(resolve("strong", "mystery/m")).candidates[0].capabilities.contextAllocated,
    ).toMatchObject({ known: false });
  });

  it("carries the catalogue's context length and modalities into the record", () => {
    const [gpt] = planOf(resolve("vision", "openai/gpt-5-mini")).candidates;
    expect(gpt.capabilities.contextAllocated).toEqual({
      known: true,
      value: 400_000,
      evidence: { source: "declared" },
    });
    expect(gpt.capabilities.imageInput).toMatchObject({ known: true, value: "base64" });
  });

  it("refuses a cloud model only on a declared shortfall, and the refusal names the measurement", () => {
    expect(failureOf(resolve("strong", "tiny/m")).failure).toMatchObject({
      code: "missing-capability",
      capability: "contextAllocated",
      message:
        "openrouter/tiny/m cannot serve the strong class: 32768 tokens of context allocated, and it needs at least 131072 tokens of context allocated",
    });
    expect(failureOf(resolve("vision", "tiny/m")).failure).toMatchObject({
      capability: "imageInput",
      message:
        "openrouter/tiny/m cannot serve the vision class: it declares no image input, and it needs image input",
    });
    expect(referencesOf(resolve("vision", "mystery/m"))).toEqual(["openrouter/mystery/m"]);
  });

  it("decides through the built-in decider when a cloud model has no decision endpoint, and a hosted decision model directly", () => {
    const [chat] = planOf(resolve("decide", "openai/gpt-5-mini")).candidates;
    expect(chat.decider).toBe("builtin");
    const [jev] = planOf(resolve("decide", "typesafe/jev-1.14")).candidates;
    expect(jev.decider).toBeUndefined();
    expect(failureOf(resolve("strong", "typesafe/jev-1.14")).failure).toMatchObject({
      capability: "tools",
    });
  });

  it("still refuses a local mill that was never measured, naming what was not measured", () => {
    const unmeasured = { tools: known(true, probed), contextAllocated: known(131_072, probed) };
    const resolution = resolvePolicy(
      { modelClass: "loop", levels: { creature: { loop: slot("ollama", "qwen3.6-35b-a3b") } } },
      probedEnvironment([ollama], { "ollama/qwen3.6-35b-a3b": unmeasured }),
    );
    expect(failureOf(resolution).failure.message).toBe(
      "ollama/qwen3.6-35b-a3b cannot serve the loop class: its decode was never measured on this node, and it needs decode measured at or above 40 tok/s on this node",
    );
  });
});

describe("resolvePolicy keeps a local creature local", () => {
  const levels: PolicyLevels = {
    creature: { strong: slot("ollama", "qwen3.8-27b") },
    workspace: { strong: slot("spark", "qwen3.8-flash-next") },
    user: { strong: slot("openrouter", "qwen/qwen3.8-27b") },
  };

  it("drops cloud fallbacks behind a local choice unless the creature allows them", () => {
    const plan = planOf(resolvePolicy({ modelClass: "strong", levels }, everyoneStrong));
    expect(plan.localOnly).toBe(true);
    expect(plan.candidates.map(({ locality }) => locality)).toEqual(["local", "local"]);
    expect(plan.refused).toEqual([
      {
        level: "user",
        candidate: { provider: "openrouter", model: "qwen/qwen3.8-27b" },
        reason: "local-only",
      },
    ]);
  });

  it("keeps the cloud fallback when the privacy flag allows it", () => {
    const plan = planOf(
      resolvePolicy({ modelClass: "strong", levels, cloudFallback: true }, everyoneStrong),
    );
    expect(plan.candidates.map(({ locality }) => locality)).toEqual(["local", "local", "cloud"]);
    expect(plan.refused).toEqual([]);
  });

  it("puts no restriction on a creature that chose the cloud", () => {
    const plan = planOf(
      resolvePolicy(
        {
          modelClass: "strong",
          levels: { creature: levels.user, workspace: levels.creature },
        },
        everyoneStrong,
      ),
    );
    expect(plan.localOnly).toBe(false);
    expect(plan.candidates.map(({ locality }) => locality)).toEqual(["cloud", "local"]);
  });
});
