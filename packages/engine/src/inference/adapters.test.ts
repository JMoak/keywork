import { describe, expect, it } from "vitest";
import { textMessage } from "../messages.ts";
import type { FetchLike } from "../providers/openai.ts";
import {
  CredentialMaterialError,
  type CredentialVault,
  modelReferenceOf,
  providerFor,
} from "./adapters.ts";
import { InferenceRegistry } from "./registry.ts";
import type { InferenceBinding, ProviderRegistration } from "./types.ts";

const handle = { id: "k", label: "saved key" };

function bind(registration: ProviderRegistration, model: string): InferenceBinding {
  const registry = new InferenceRegistry();
  registry.register(registration);
  const resolution = registry.bind(`${registration.name}/${model}`);
  if (!resolution.ok) throw new Error(resolution.failure.message);
  return resolution.binding;
}

function recordingFetch(): {
  fetchFn: FetchLike;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response("data: [DONE]\n\n", { status: 200 });
  };
  return { fetchFn, calls };
}

const request = { systemPrompt: "", messages: [textMessage("user", "hi")], tools: [] };

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of iterable) {
  }
}

const keyVault: CredentialVault = {
  material: (requested) =>
    requested.id === handle.id ? { kind: "api-key", key: "secret" } : undefined,
};

describe("providerFor", () => {
  it("builds a chat-completions transport with the handle's api key and the registration decorations", async () => {
    const { fetchFn, calls } = recordingFetch();
    const provider = providerFor(
      bind(
        {
          name: "openrouter",
          protocol: "chat-completions",
          endpoint: "https://openrouter.ai/api/v1",
          credential: { kind: "present", handle },
          models: [],
          openCatalog: true,
          enabled: true,
          decorations: { headers: { "x-title": "keywork" }, body: { usage: { include: true } } },
        },
        "openai/gpt-5-mini",
      ),
      { vault: keyVault, fetchFn },
    );
    await drain(provider.stream(request));

    expect(provider.name).toBe("openrouter");
    expect(provider.modelId).toBe("openai/gpt-5-mini");
    expect(modelReferenceOf(provider)).toBe("openrouter/openai/gpt-5-mini");
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: "Bearer secret",
      "x-title": "keywork",
    });
    expect(JSON.parse(calls[0]?.init?.body as string)).toMatchObject({ usage: { include: true } });
  });

  it("sends no authorization at all for a credential-free loopback endpoint", async () => {
    const { fetchFn, calls } = recordingFetch();
    const provider = providerFor(
      bind(
        {
          name: "ollama",
          protocol: "chat-completions",
          endpoint: "http://localhost:11434/v1",
          credential: { kind: "none" },
          models: [],
          openCatalog: true,
          enabled: true,
        },
        "qwen3",
      ),
      { vault: { material: () => undefined }, fetchFn },
    );
    await drain(provider.stream(request));
    expect(calls[0]?.init?.headers).not.toHaveProperty("authorization");
  });

  it("builds a responses transport against <endpoint>/responses with bearer material", async () => {
    const { fetchFn, calls } = recordingFetch();
    const vault: CredentialVault = {
      material: () => ({
        kind: "bearer",
        headers: async () => ({ authorization: "Bearer fresh" }),
      }),
    };
    const provider = providerFor(
      bind(
        {
          name: "openai-codex",
          protocol: "responses",
          endpoint: "https://chatgpt.com/backend-api/codex",
          credential: { kind: "present", handle },
          models: [],
          openCatalog: true,
          enabled: true,
        },
        "gpt-5.5",
      ),
      { vault, fetchFn },
    );
    await drain(provider.stream(request));
    expect(calls[0]?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: "Bearer fresh" });
  });

  it("refuses to build when the vault no longer holds the handle's material", () => {
    expect(() =>
      providerFor(
        bind(
          {
            name: "openai",
            protocol: "chat-completions",
            endpoint: "https://api.openai.com/v1",
            credential: { kind: "present", handle },
            models: [],
            openCatalog: true,
            enabled: true,
          },
          "gpt-5",
        ),
        { vault: { material: () => undefined } },
      ),
    ).toThrow(CredentialMaterialError);
  });

  it("refuses mismatched material shapes per protocol", () => {
    const bedrock = bind(
      {
        name: "bedrock",
        protocol: "bedrock-converse",
        endpoint: "us-east-1",
        credential: { kind: "present", handle },
        models: [],
        openCatalog: true,
        enabled: true,
      },
      "amazon.nova-lite-v1:0",
    );
    expect(() => providerFor(bedrock, { vault: keyVault })).toThrow(/SigV4/);
  });

  it("gates requests on the binding's declared capabilities", async () => {
    const provider = providerFor(
      bind(
        {
          name: "openai",
          protocol: "chat-completions",
          endpoint: "https://api.openai.com/v1",
          credential: { kind: "present", handle },
          models: [
            { id: "gpt-5", origin: "declared", capabilities: { input: ["text"], toolCalls: true } },
          ],
          openCatalog: true,
          enabled: true,
        },
        "gpt-5",
      ),
      { vault: keyVault, fetchFn: recordingFetch().fetchFn },
    );
    const withImage = {
      ...request,
      messages: [
        {
          role: "user" as const,
          parts: [{ type: "image" as const, mediaType: "image/png", data: "aGk=" }],
        },
      ],
    };
    expect(() => provider.stream(withImage)).toThrow(/text-only/);
  });
});
