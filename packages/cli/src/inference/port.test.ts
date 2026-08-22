import type { ResolutionFailure } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { inferencePort, nextActionFor, shellCommands, slashCommands } from "./port.ts";
import { composeInference } from "./runtime.ts";

describe("inferencePort", () => {
  const built = composeInference({
    env: { OPENAI_API_KEY: "k" },
    config: {
      connections: { ollama: { endpoint: "http://localhost:11434/v1", models: ["qwen3"] } },
      models: { qwen3: { contextWindow: 32_768 } },
    },
    credentials: {},
    observations: {
      ollama: { models: ["qwen3", "llama3"], modelsReportedAt: "2026-08-21T10:00:00Z" },
    },
  });
  const port = inferencePort({ registry: () => built.registry, observations: () => ({}) });

  it("lists available models first, alphabetically, with factual rows and no ranking", () => {
    const choices = port.choices();
    expect(choices.map((choice) => [choice.reference, choice.available])).toEqual([
      ["ollama/llama3", true],
      ["ollama/qwen3", true],
      ["openai/gpt-5-mini", true],
      ["bedrock/amazon.nova-lite-v1:0", false],
      ["openai-codex/gpt-5.5", false],
      ["openrouter/openai/gpt-5-mini", false],
    ]);
    expect(choices[1]?.facts).toEqual(["chat-completions", "no credential", "declared", "ctx 33k"]);
    expect(choices[0]?.facts).toEqual(["chat-completions", "no credential", "reported"]);
    expect(choices[2]?.facts).toEqual(["chat-completions", "OPENAI_API_KEY", "provider default"]);
    expect(choices[5]?.facts[1]).toContain("needs KEYWORK_OPENROUTER_API_KEY");
  });

  it("describes a reference without side effects, carrying the typed failure and a next step", () => {
    expect(port.describe("ollama/qwen3")).toEqual({
      ok: true,
      message: "ollama/qwen3 · chat-completions · ctx 33k",
    });
    expect(port.describe("ollama/llama3")).toEqual({
      ok: true,
      message: "ollama/llama3 · chat-completions · ctx assumed",
    });
    expect(port.describe("openrouter/x")).toMatchObject({
      ok: false,
      code: "unavailable-credential",
      nextAction: "run /connect openrouter",
    });
    expect(port.describe("nope/x")).toMatchObject({ ok: false, code: "ambiguous" });
  });
});

describe("nextActionFor", () => {
  const failures: Record<string, ResolutionFailure> = {
    nothingConfigured: { code: "unconfigured", available: [], message: "m" },
    noDefault: { code: "unconfigured", available: ["lmstudio"], message: "m" },
    ambiguousDefault: {
      code: "ambiguous",
      reference: "",
      candidates: ["a/x", "b/x"],
      message: "m",
    },
    ambiguousBare: { code: "ambiguous", reference: "x", candidates: ["a/x", "b/x"], message: "m" },
    unknownProvider: {
      code: "unknown-provider",
      reference: "nope/x",
      provider: "nope",
      known: [],
      message: "m",
    },
    unknownModelAnywhere: {
      code: "unknown-model",
      reference: "zzz",
      provider: undefined,
      known: [],
      message: "m",
    },
    unknownModelOnProvider: {
      code: "unknown-model",
      reference: "closed/b",
      provider: "closed",
      known: ["a"],
      message: "m",
    },
    disabled: { code: "disabled-provider", reference: "p/m", provider: "p", message: "m" },
    noCredential: {
      code: "unavailable-credential",
      reference: "openai/m",
      provider: "openai",
      expected: "OPENAI_API_KEY",
      message: "m",
    },
    protocol: { code: "unsupported-protocol", reference: "p/m", protocol: "grpc", message: "m" },
    capability: {
      code: "missing-capability",
      reference: "p/chatty",
      model: "chatty",
      capability: "toolCalls",
      message: "m",
    },
    insecure: {
      code: "insecure-endpoint",
      reference: "lan/m",
      provider: "lan",
      endpoint: "http://10.0.0.5/v1",
      message: "m",
    },
  };

  it("words every IR-18 code for the TUI with slash commands", () => {
    expect(
      Object.fromEntries(
        Object.entries(failures).map(([name, failure]) => [name, nextActionFor(failure)]),
      ),
    ).toEqual({
      nothingConfigured: "run /connect",
      noDefault: "pick one with /model",
      ambiguousDefault: 'pick one with /model or set "model" in keywork.json',
      ambiguousBare: "qualify it as provider/model",
      unknownProvider: "run /connect nope to add it",
      unknownModelAnywhere:
        "use a provider-qualified reference like provider/model, or /connect a provider",
      unknownModelOnProvider: "run /connect closed to refresh its models, or pick one with /model",
      disabled: "enable it with /connect p",
      noCredential: "run /connect openai",
      protocol: "set it to one of chat-completions, responses, bedrock-converse",
      capability: 'declare models["chatty"].toolCalls: true once the model supports it',
      insecure:
        "use an https:// endpoint, or set connections.lan.insecureTransport after reading its risk note",
    });
  });

  it("swaps in shell commands for keywork run and keywork chat", () => {
    expect(nextActionFor(failures.nothingConfigured as ResolutionFailure, shellCommands)).toBe(
      "run keywork connect",
    );
    expect(nextActionFor(failures.noDefault as ResolutionFailure, shellCommands)).toBe(
      "pick one with --model",
    );
    expect(nextActionFor(failures.unknownProvider as ResolutionFailure, shellCommands)).toBe(
      "run keywork connect nope to add it",
    );
    expect(nextActionFor(failures.ambiguousBare as ResolutionFailure, shellCommands)).toBe(
      "qualify it as provider/model",
    );
  });

  it("defaults to the slash vocabulary", () => {
    for (const failure of Object.values(failures)) {
      expect(nextActionFor(failure)).toBe(nextActionFor(failure, slashCommands));
    }
  });
});
