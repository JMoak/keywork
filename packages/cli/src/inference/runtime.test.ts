import { type Resolution, UndeclaredCapabilityError } from "@keywork/engine";
import type { KeyworkConfig } from "@keywork/shared";
import { describe, expect, it } from "vitest";
import type { CredentialMap } from "../auth-store.ts";
import type { ObservationMap } from "./observations.ts";
import { composeInference, type InferenceInputs } from "./runtime.ts";

function runtime(overrides: Partial<InferenceInputs> = {}) {
  return composeInference({ env: {}, config: {}, credentials: {}, ...overrides });
}

function reference(resolution: Resolution): string | undefined {
  return resolution.ok
    ? `${resolution.binding.reference.provider}/${resolution.binding.reference.model}`
    : undefined;
}

function code(resolution: Resolution): string | undefined {
  return resolution.ok ? undefined : resolution.failure.code;
}

const oauth: CredentialMap = {
  "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 9e15 },
};

describe("composeInference built-ins", () => {
  it("is unconfigured with no credentials anywhere", () => {
    expect(code(runtime().resolve({}))).toBe("unconfigured");
  });

  it("makes the sole credentialed built-in the zero-config default", () => {
    expect(reference(runtime({ env: { OPENAI_API_KEY: "k" } }).resolve({}))).toBe(
      "openai/gpt-5-mini",
    );
    expect(reference(runtime({ env: { OPENROUTER_API_KEY: "k" } }).resolve({}))).toBe(
      "openrouter/openai/gpt-5-mini",
    );
    expect(reference(runtime({ credentials: oauth }).resolve({}))).toBe("openai-codex/gpt-5.5");
  });

  it("refuses to pick among several credentialed providers by order", () => {
    const both = runtime({ env: { OPENAI_API_KEY: "k", OPENROUTER_API_KEY: "k2" } });
    expect(code(both.resolve({}))).toBe("ambiguous");
    expect(reference(both.resolve({ default: "openrouter/openai/gpt-5-mini" }))).toBe(
      "openrouter/openai/gpt-5-mini",
    );
  });

  it("lets a KEYWORK_-scoped variable outrank a saved key, which outranks the ambient variable", () => {
    const saved: CredentialMap = { openai: { type: "api_key", key: "saved" } };
    const scoped = runtime({
      env: { KEYWORK_OPENAI_API_KEY: "scoped", OPENAI_API_KEY: "ambient" },
      credentials: saved,
    });
    const savedOnly = runtime({ env: { OPENAI_API_KEY: "ambient" }, credentials: saved });
    const ambient = runtime({ env: { OPENAI_API_KEY: "ambient" } });
    const labelOf = (built: ReturnType<typeof runtime>) => {
      const credential = built.registry.registration("openai")?.credential;
      return credential?.kind === "present" ? credential.handle.label : credential?.kind;
    };
    expect(labelOf(scoped)).toBe("KEYWORK_OPENAI_API_KEY");
    expect(labelOf(savedOnly)).toBe("saved key");
    expect(labelOf(ambient)).toBe("OPENAI_API_KEY");
  });

  it("ignores empty credential values", () => {
    expect(code(runtime({ env: { OPENROUTER_API_KEY: "" } }).resolve({}))).toBe("unconfigured");
  });

  it("registers bedrock from AWS credentials plus a region from env or config", () => {
    const aws = { AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "secret" };
    expect(code(runtime({ env: aws }).resolve({}))).toBe("unconfigured");
    expect(reference(runtime({ env: { ...aws, AWS_REGION: "us-east-1" } }).resolve({}))).toBe(
      "bedrock/amazon.nova-lite-v1:0",
    );
    expect(
      reference(runtime({ env: aws, config: { bedrockRegion: "eu-west-1" } }).resolve({})),
    ).toBe("bedrock/amazon.nova-lite-v1:0");
  });

  it("answers a qualified reference for a credential-less built-in with unavailable-credential", () => {
    const resolution = runtime({ env: { OPENROUTER_API_KEY: "k" } }).resolve({
      override: "openai/gpt-5",
    });
    expect(code(resolution)).toBe("unavailable-credential");
  });

  it("keeps the openrouter usage-accounting decoration on its registration only", () => {
    const built = runtime({ env: { OPENROUTER_API_KEY: "k", OPENAI_API_KEY: "k" } });
    expect(built.registry.registration("openrouter")?.decorations?.body).toEqual({
      usage: { include: true },
    });
    expect(built.registry.registration("openai")?.decorations).toBeUndefined();
  });
});

describe("composeInference connections", () => {
  const config: KeyworkConfig = {
    connections: {
      ollama: { endpoint: "http://localhost:11434/v1", models: ["qwen3"] },
      gateway: { endpoint: "https://gw.example/v1", credential: "env:GW_KEY" },
      lan: { endpoint: "http://10.0.0.9:8080/v1", credential: "none" },
    },
  };

  it("treats a loopback connection as credential-free and bindable by default", () => {
    expect(reference(runtime({ config }).resolve({ override: "ollama/qwen3" }))).toBe(
      "ollama/qwen3",
    );
    expect(reference(runtime({ config }).resolve({ override: "ollama/anything-open" }))).toBe(
      "ollama/anything-open",
    );
  });

  it("reads an env: credential source and reports it missing by variable name", () => {
    const missing = runtime({ config }).resolve({ override: "gateway/m" });
    expect(code(missing)).toBe("unavailable-credential");
    if (!missing.ok && missing.failure.code === "unavailable-credential") {
      expect(missing.failure.expected).toBe("GW_KEY");
    }
    expect(
      reference(runtime({ config, env: { GW_KEY: "k" } }).resolve({ override: "gateway/m" })),
    ).toBe("gateway/m");
  });

  it("expects a saved key for a remote connection without an explicit credential source", () => {
    const remote: KeyworkConfig = {
      connections: { broker: { endpoint: "https://broker.example/v1" } },
    };
    expect(code(runtime({ config: remote }).resolve({ override: "broker/m" }))).toBe(
      "unavailable-credential",
    );
    const saved: CredentialMap = { broker: { type: "api_key", key: "k" } };
    expect(
      reference(runtime({ config: remote, credentials: saved }).resolve({ override: "broker/m" })),
    ).toBe("broker/m");
  });

  it("refuses plain http off loopback until insecureTransport is declared", () => {
    expect(code(runtime({ config }).resolve({ override: "lan/m" }))).toBe("insecure-endpoint");
    const allowed: KeyworkConfig = {
      connections: {
        lan: { endpoint: "http://10.0.0.9:8080/v1", credential: "none", insecureTransport: true },
      },
    };
    expect(reference(runtime({ config: allowed }).resolve({ override: "lan/m" }))).toBe("lan/m");
  });

  it("merges declared models with reported inventory, declared first and deduplicated", () => {
    const observations: ObservationMap = {
      ollama: { models: ["qwen3", "llama3"], modelsReportedAt: "2026-08-21T00:00:00Z" },
    };
    const registration = runtime({ config, observations }).registry.registration("ollama");
    expect(registration?.models.map((spec) => [spec.id, spec.origin])).toEqual([
      ["qwen3", "declared"],
      ["llama3", "reported"],
    ]);
  });

  it("warns about and skips a connection named like a built-in", () => {
    const clash: KeyworkConfig = {
      connections: { openai: { endpoint: "https://evil.example/v1" } },
    };
    const built = runtime({ config: clash, env: { OPENAI_API_KEY: "k" } });
    expect(built.warnings).toEqual([
      "connections.openai is ignored: that name belongs to a built-in provider",
    ]);
    expect(built.registry.registration("openai")?.endpoint).toBe("https://api.openai.com/v1");
  });

  it("disables a connection without forgetting it", () => {
    const off: KeyworkConfig = {
      connections: { ollama: { endpoint: "http://localhost:11434/v1", enabled: false } },
    };
    expect(code(runtime({ config: off }).resolve({ override: "ollama/qwen3" }))).toBe(
      "disabled-provider",
    );
  });
});

describe("composeInference providers", () => {
  it("opens a provider that carries the binding's declared capabilities", () => {
    const built = runtime({
      env: { OPENAI_API_KEY: "k" },
      config: { models: { "gpt-5*": { input: ["text"] } } },
    });
    const { provider, reference: ref } = built.open({ override: "openai/gpt-5-mini" });
    expect(ref).toBe("openai/gpt-5-mini");
    const imageRequest = {
      systemPrompt: "",
      messages: [
        {
          role: "user" as const,
          parts: [{ type: "image" as const, mediaType: "image/png", data: "aGk=" }],
        },
      ],
      tools: [],
    };
    expect(() => provider.stream(imageRequest)).toThrow(UndeclaredCapabilityError);
  });

  it("throws a typed ResolutionError from open when nothing binds", () => {
    expect(() => runtime().open({})).toThrow(/no inference provider is configured/);
  });
});
