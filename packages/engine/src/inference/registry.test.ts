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

describe("InferenceRegistry", () => {
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
