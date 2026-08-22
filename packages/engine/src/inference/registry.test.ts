import { describe, expect, it } from "vitest";
import { InferenceRegistry } from "./registry.ts";
import { InvalidRegistrationError, type ProviderRegistration } from "./types.ts";

const present = { kind: "present", handle: { id: "h", label: "saved key" } } as const;
const missing = { kind: "missing", expected: "OPENAI_API_KEY" } as const;

function registration(
  overrides: Partial<ProviderRegistration> & { name: string },
): ProviderRegistration {
  return {
    protocol: "chat-completions",
    endpoint: "https://example.test/v1",
    credential: present,
    models: [],
    openCatalog: true,
    enabled: true,
    ...overrides,
  };
}

function registry(...registrations: ProviderRegistration[]): InferenceRegistry {
  const built = new InferenceRegistry();
  for (const entry of registrations) built.register(entry);
  return built;
}

const openai = registration({ name: "openai", defaultModel: "gpt-5-mini" });
const local = registration({
  name: "ollama",
  endpoint: "http://localhost:11434/v1",
  credential: { kind: "none" },
  models: [{ id: "qwen3", origin: "reported" }],
});

describe("InferenceRegistry", () => {
  it("resolves and binds over everything registered", () => {
    const built = registry(openai, local);
    const resolved = built.resolve({ default: "openai/gpt-5" });
    expect(resolved.ok && resolved.binding.reference).toEqual({
      provider: "openai",
      model: "gpt-5",
    });
    const bound = built.bind("qwen3");
    expect(bound.ok && bound.binding.reference).toEqual({ provider: "ollama", model: "qwen3" });
  });

  it("replaces a registration by name and keeps earlier bindings untouched", () => {
    const built = registry(openai);
    const before = built.bind("openai/gpt-5");
    built.register({ ...openai, credential: missing });
    expect(built.all()).toHaveLength(1);
    expect(built.registration("openai")?.credential.kind).toBe("missing");
    expect(before.ok && before.binding.registration.credential.kind).toBe("present");
    expect(built.bind("openai/gpt-5")).toMatchObject({
      ok: false,
      failure: { code: "unavailable-credential" },
    });
  });

  it("separates available registrations from the full list", () => {
    const built = registry(local, registration({ name: "openai", credential: missing }));
    expect(built.all().map((entry) => entry.name)).toEqual(["ollama", "openai"]);
    expect(built.available().map((entry) => entry.name)).toEqual(["ollama"]);
  });

  it("lists the catalog in registration order with availability", () => {
    const built = registry(
      local,
      registration({
        name: "openai",
        credential: missing,
        models: [{ id: "gpt-5", origin: "declared" }],
      }),
    );
    expect(
      built
        .catalog()
        .map((entry) => [`${entry.reference.provider}/${entry.reference.model}`, entry.available]),
    ).toEqual([
      ["ollama/qwen3", true],
      ["openai/gpt-5", false],
    ]);
  });

  it("refuses malformed registrations up front", () => {
    expect(() => registry(registration({ name: "bad/name" }))).toThrow(InvalidRegistrationError);
    expect(() => registry(registration({ name: "" }))).toThrow(InvalidRegistrationError);
    expect(() => registry(registration({ name: "x", endpoint: "not a url" }))).toThrow(
      InvalidRegistrationError,
    );
    expect(() =>
      registry(registration({ name: "b", protocol: "bedrock-converse", endpoint: "" })),
    ).toThrow(InvalidRegistrationError);
    expect(() =>
      registry(registration({ name: "p", protocol: "grpc" as ProviderRegistration["protocol"] })),
    ).toThrow(/unknown protocol/);
  });
});
