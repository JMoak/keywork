import { describe, expect, it } from "vitest";
import { type CredentialMaterial, CredentialMaterialError } from "../../inference/adapters.ts";
import type { InferenceBinding, ProviderRegistration } from "../../inference/types.ts";
import { resolvePolicy } from "../policy/index.ts";
import { recorded, replaying, type SentRequest } from "./fixtures/cassette.ts";
import { deciderFor, hostedDecisionModel, nativeDecisionModel } from "./index.ts";
import type { DecisionRequest } from "./types.ts";

function registration(
  name: string,
  endpoint: string,
  credential: ProviderRegistration["credential"] = { kind: "none" },
): ProviderRegistration {
  return {
    name,
    protocol: "chat-completions",
    endpoint,
    credential,
    models: [],
    openCatalog: true,
    enabled: true,
  };
}

function vaultOf(materials: Record<string, CredentialMaterial>) {
  return { material: (handle: { id: string }) => materials[handle.id] };
}

const openrouter = registration("openrouter", "https://openrouter.ai/api/v1", {
  kind: "present",
  handle: { id: "or", label: "OPENROUTER_API_KEY" },
});

function decideBinding(
  registrations: readonly ProviderRegistration[],
  provider: string,
  model: string,
): InferenceBinding {
  const resolution = resolvePolicy(
    { modelClass: "decide", levels: { creature: { decide: { provider, model } } } },
    {
      registrations,
      capabilityOf: () => undefined,
      now: () => new Date("2026-11-05T00:00:00Z"),
    },
  );
  if (!resolution.ok || resolution.kind !== "plan") throw new Error("expected a decide plan");
  return resolution.plan.candidates[0].binding;
}

describe("deciderFor a resolved decide candidate", () => {
  it("asks hosted Jev through OpenRouter with the vault's key", async () => {
    const sent: SentRequest[] = [];
    const entry = recorded("openrouter-jev-1.14");
    const decider = deciderFor(decideBinding([openrouter], "openrouter", "typesafe/jev-1.14"), {
      vault: vaultOf({ or: { kind: "api-key", key: "sk-or-vault" } }),
      fetchFn: replaying(entry, sent),
    });
    const reply = await decider.decide(entry.request.body as DecisionRequest);
    expect(reply.ok).toBe(true);
    expect(sent[0]?.url).toBe("https://openrouter.ai/api/v1/systemone");
    expect(sent[0]?.headers.authorization).toBe("Bearer sk-or-vault");
  });

  it("asks a local decision model on its own server without a key", async () => {
    const sent: SentRequest[] = [];
    const entry = recorded("ollama-nimble-no-usage");
    const ollama = registration("ollama", "http://localhost:11434/v1");
    const binding: InferenceBinding = {
      reference: { provider: "ollama", model: "nimble" },
      registration: ollama,
      spec: { id: "nimble", origin: "unlisted" },
      protocol: "chat-completions",
      capabilities: { input: ["text"], toolCalls: false },
      credential: undefined,
    };
    const decider = deciderFor(binding, { vault: vaultOf({}), fetchFn: replaying(entry, sent) });
    await decider.decide(entry.request.body as DecisionRequest);
    expect(sent[0]?.url).toBe("http://localhost:11434/v1/systemone");
    expect(sent[0]?.headers.authorization).toBeUndefined();
  });

  it("refuses a credential the vault no longer holds", () => {
    const binding = decideBinding([openrouter], "openrouter", "typesafe/jev-1.14");
    expect(() => deciderFor(binding, { vault: vaultOf({}) })).toThrow(CredentialMaterialError);
  });

  it("refuses AWS credentials, which no decision endpoint takes", () => {
    const binding = decideBinding([openrouter], "openrouter", "typesafe/jev-1.14");
    const aws: CredentialMaterial = {
      kind: "aws-sigv4",
      credentials: { accessKeyId: "a", secretAccessKey: "s" },
    };
    expect(() => deciderFor(binding, { vault: vaultOf({ or: aws }) })).toThrow(/AWS SigV4/);
  });
});

describe("nativeDecisionModel", () => {
  it("reads llama-server's output modalities", () => {
    const entry = {
      id: "nimble",
      architecture: { input_modalities: ["text"], output_modalities: ["decisions"] },
    };
    expect(nativeDecisionModel(entry)).toBe(true);
    expect(
      nativeDecisionModel({
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      }),
    ).toBe(false);
  });

  it("reads LM Studio's model type", () => {
    expect(nativeDecisionModel({ key: "clef-flash", type: "decision" })).toBe(true);
    expect(nativeDecisionModel({ key: "qwen3.8-27b", type: "llm" })).toBe(false);
  });

  it("reads Ollama's capabilities from /api/show", () => {
    expect(nativeDecisionModel({ capabilities: ["completion", "decision"] })).toBe(true);
    expect(nativeDecisionModel({ capabilities: ["completion", "vision", "tools"] })).toBe(false);
  });

  it("says no to anything else", () => {
    expect(nativeDecisionModel(undefined)).toBe(false);
    expect(nativeDecisionModel({ id: "qwen3.8-27b" })).toBe(false);
  });
});

describe("hostedDecisionModel", () => {
  it("knows Jev by host and pinned id", () => {
    expect(hostedDecisionModel("https://openrouter.ai/api/v1", "typesafe/jev-1.14")).toMatchObject({
      label: "Jev 1.14 via OpenRouter",
    });
    expect(hostedDecisionModel("https://openrouter.ai/api/v1", "qwen/qwen3.8-27b")).toBeUndefined();
    expect(hostedDecisionModel("http://localhost:11434/v1", "typesafe/jev-1.14")).toBeUndefined();
  });
});
