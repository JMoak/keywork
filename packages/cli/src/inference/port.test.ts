import { describe, expect, it } from "vitest";
import { inferencePort } from "./port.ts";
import { composeInference } from "./runtime.ts";

describe("inferencePort", () => {
  const built = composeInference({
    env: { OPENAI_API_KEY: "k" },
    config: {
      connections: { ollama: { endpoint: "http://localhost:11434/v1", models: ["qwen3"] } },
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
    expect(choices[1]?.facts).toEqual(["chat-completions", "no credential", "declared"]);
    expect(choices[0]?.facts).toEqual(["chat-completions", "no credential", "reported"]);
    expect(choices[2]?.facts).toEqual(["chat-completions", "OPENAI_API_KEY", "provider default"]);
    expect(choices[5]?.facts[1]).toContain("needs KEYWORK_OPENROUTER_API_KEY");
  });

  it("describes a reference without side effects, carrying the typed failure forward", () => {
    expect(port.describe("ollama/qwen3")).toEqual({
      ok: true,
      message: "ollama/qwen3 · chat-completions",
    });
    expect(port.describe("openrouter/x")).toMatchObject({
      ok: false,
      code: "unavailable-credential",
    });
    expect(port.describe("nope/x")).toMatchObject({ ok: false, code: "ambiguous" });
  });
});
