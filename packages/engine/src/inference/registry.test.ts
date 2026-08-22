import { describe, expect, it } from "vitest";
import { InferenceRegistry } from "./registry.ts";
import {
  InvalidRegistrationError,
  type ProviderRegistration,
  type Resolution,
  type ResolutionFailureCode,
} from "./types.ts";

const present = { kind: "present", handle: { id: "h", label: "saved key" } } as const;
const missing = { kind: "missing", expected: "OPENAI_API_KEY or /connect openai" } as const;

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

function failureCode(resolution: Resolution): ResolutionFailureCode | undefined {
  return resolution.ok ? undefined : resolution.failure.code;
}

function boundReference(resolution: Resolution): string | undefined {
  return resolution.ok
    ? `${resolution.binding.reference.provider}/${resolution.binding.reference.model}`
    : undefined;
}

const local = registration({
  name: "ollama",
  endpoint: "http://localhost:11434/v1",
  credential: { kind: "none" },
  models: [{ id: "qwen3", origin: "reported" }],
  openCatalog: true,
});

const openai = registration({ name: "openai", defaultModel: "gpt-5-mini" });
const openrouter = registration({ name: "openrouter", defaultModel: "openai/gpt-5-mini" });

describe("InferenceRegistry precedence (IR-07)", () => {
  it("is unconfigured when nothing available exists", () => {
    const resolution = registry(registration({ name: "openai", credential: missing })).resolve({});
    expect(failureCode(resolution)).toBe("unconfigured");
    expect(resolution.ok ? "" : resolution.failure.nextAction).toContain("/connect");
  });

  it("applies the explicit override before every other source and never falls through", () => {
    const resolution = registry(openai, local).resolve({
      override: "ollama/nope-but-open",
      selection: "openai/gpt-5",
      default: "openai/gpt-5-mini",
    });
    expect(boundReference(resolution)).toBe("ollama/nope-but-open");
    const failed = registry(openai, local).resolve({
      override: "missing/model",
      selection: "openai/gpt-5",
    });
    expect(failureCode(failed)).toBe("ambiguous");
  });

  it("lets the session selection outrank the user default", () => {
    const resolution = registry(openai, local).resolve({
      selection: "ollama/qwen3",
      default: "openai/gpt-5-mini",
    });
    expect(boundReference(resolution)).toBe("ollama/qwen3");
  });

  it("uses the sole available model as the zero-config default", () => {
    expect(boundReference(registry(openai).resolve({}))).toBe("openai/gpt-5-mini");
    expect(
      boundReference(
        registry(local, registration({ name: "openai", credential: missing })).resolve({}),
      ),
    ).toBe("ollama/qwen3");
  });

  it("refuses to choose by registry order when several models could be the default", () => {
    const resolution = registry(openrouter, openai).resolve({});
    expect(failureCode(resolution)).toBe("ambiguous");
    if (!resolution.ok && resolution.failure.code === "ambiguous") {
      expect(resolution.failure.candidates).toEqual([
        "openrouter/openai/gpt-5-mini",
        "openai/gpt-5-mini",
      ]);
    }
  });

  it("reports an available provider with no listed or default model as unconfigured with /model as the next step", () => {
    const bare = registration({
      name: "lmstudio",
      endpoint: "http://127.0.0.1:1234/v1",
      credential: { kind: "none" },
    });
    const resolution = registry(bare).resolve({});
    expect(failureCode(resolution)).toBe("unconfigured");
    expect(resolution.ok ? "" : resolution.failure.nextAction).toContain("/model");
  });
});

describe("InferenceRegistry references (IR-06)", () => {
  it("keeps provider-qualified references apart even when the model ids collide", () => {
    const built = registry(openai, openrouter, local);
    expect(boundReference(built.bind("openai/gpt-5"))).toBe("openai/gpt-5");
    expect(boundReference(built.bind("openrouter/gpt-5"))).toBe("openrouter/gpt-5");
    expect(boundReference(built.bind("ollama/gpt-5"))).toBe("ollama/gpt-5");
  });

  it("treats a slash model id as bare when its first segment is not a registered provider", () => {
    const resolution = registry(openrouter).bind("anthropic/claude-x");
    expect(boundReference(resolution)).toBe("openrouter/anthropic/claude-x");
  });

  it("resolves a bare name through the one provider that lists it before any open catalog", () => {
    expect(boundReference(registry(openai, local).bind("qwen3"))).toBe("ollama/qwen3");
  });

  it("fails a bare name served by several available providers and names the candidates", () => {
    const resolution = registry(openai, openrouter).bind("gpt-5");
    expect(failureCode(resolution)).toBe("ambiguous");
    if (!resolution.ok && resolution.failure.code === "ambiguous") {
      expect(resolution.failure.candidates).toEqual(["openai/gpt-5", "openrouter/gpt-5"]);
    }
  });

  it("points a bare name at its only provider even when that provider lacks a credential", () => {
    const resolution = registry(registration({ name: "openai", credential: missing })).bind(
      "gpt-5",
    );
    expect(failureCode(resolution)).toBe("unavailable-credential");
  });

  it("fails a bare name nobody serves as unknown-model", () => {
    const closed = registration({
      name: "closed",
      openCatalog: false,
      models: [{ id: "a", origin: "declared" }],
    });
    expect(failureCode(registry(closed).bind("zzz"))).toBe("unknown-model");
  });
});

describe("InferenceRegistry typed failures (IR-18)", () => {
  it("names an unknown provider and the known ones when no open catalog could serve the text", () => {
    const closed = registration({
      name: "closed",
      openCatalog: false,
      models: [{ id: "a", origin: "declared" }],
    });
    const resolution = registry(closed).resolve({ override: "nope/model" });
    expect(failureCode(resolution)).toBe("unknown-provider");
    if (!resolution.ok && resolution.failure.code === "unknown-provider") {
      expect(resolution.failure.provider).toBe("nope");
      expect(resolution.failure.known).toEqual(["closed"]);
    }
  });

  it("reports a disabled provider", () => {
    const resolution = registry(registration({ name: "openai", enabled: false })).bind(
      "openai/gpt-5",
    );
    expect(failureCode(resolution)).toBe("disabled-provider");
  });

  it("reports a missing credential and suggests another provider that could serve the same model", () => {
    const resolution = registry(
      registration({ name: "openai", credential: missing }),
      openrouter,
    ).bind("openai/gpt-5-mini");
    expect(failureCode(resolution)).toBe("unavailable-credential");
    expect(resolution.ok ? "" : resolution.failure.message).toContain(
      "openrouter/openai/gpt-5-mini",
    );
  });

  it("reports an unlisted model on a closed catalog", () => {
    const closed = registration({
      name: "closed",
      openCatalog: false,
      models: [{ id: "a", origin: "declared" }],
    });
    const resolution = registry(closed).bind("closed/b");
    expect(failureCode(resolution)).toBe("unknown-model");
    if (!resolution.ok && resolution.failure.code === "unknown-model")
      expect(resolution.failure.known).toEqual(["a"]);
  });

  it("refuses plain http off loopback unless the registration opts into insecure transport", () => {
    const lan = registration({
      name: "lan",
      endpoint: "http://10.0.0.5:8080/v1",
      credential: { kind: "none" },
    });
    expect(failureCode(registry(lan).bind("lan/m"))).toBe("insecure-endpoint");
    expect(boundReference(registry({ ...lan, insecureTransport: true }).bind("lan/m"))).toBe(
      "lan/m",
    );
    expect(boundReference(registry(local).bind("ollama/qwen3"))).toBe("ollama/qwen3");
  });

  it("refuses a model declared without tool calls", () => {
    const noTools = registration({
      name: "p",
      models: [
        { id: "chatty", origin: "declared", capabilities: { input: ["text"], toolCalls: false } },
      ],
    });
    expect(failureCode(registry(noTools).bind("p/chatty"))).toBe("missing-capability");
  });
});

describe("InferenceRegistry bindings (IR-02, IR-04)", () => {
  it("produces a frozen binding carrying protocol, capabilities, and the credential handle", () => {
    const resolution = registry(openai).bind("openai/gpt-5");
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(Object.isFrozen(resolution.binding)).toBe(true);
    expect(resolution.binding.protocol).toBe("chat-completions");
    expect(resolution.binding.capabilities).toEqual({ input: ["text"], toolCalls: true });
    expect(resolution.binding.credential).toEqual({ id: "h", label: "saved key" });
    expect(resolution.binding.spec.origin).toBe("unlisted");
  });

  it("lets a model override the registration protocol", () => {
    const mixed = registration({
      name: "gw",
      models: [{ id: "reasoner", origin: "declared", protocol: "responses" }],
    });
    const resolution = registry(mixed).bind("gw/reasoner");
    expect(resolution.ok && resolution.binding.protocol).toBe("responses");
  });

  it("keeps earlier bindings untouched when a registration is replaced", () => {
    const built = registry(openai);
    const before = built.bind("openai/gpt-5");
    built.register({ ...openai, credential: missing });
    expect(before.ok && before.binding.registration.credential.kind).toBe("present");
    expect(failureCode(built.bind("openai/gpt-5"))).toBe("unavailable-credential");
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
    expect(() => registry(registration({ name: "x", endpoint: "not a url" }))).toThrow(
      InvalidRegistrationError,
    );
    expect(() =>
      registry(registration({ name: "b", protocol: "bedrock-converse", endpoint: "" })),
    ).toThrow(InvalidRegistrationError);
  });
});
