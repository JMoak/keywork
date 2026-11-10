import { expect, it } from "vitest";
import { type ProviderRequest, ProviderRequestControlError } from "../../provider.ts";
import { localChatProvider } from "./local-chat.ts";
import { ollamaDeltas } from "./ollama/deltas.ts";

it.each<Partial<ProviderRequest>>([
  { maxOutputTokens: 10 },
  { retry: "never" },
  { openRouterRouting: { only: ["openai"], maxPrice: { prompt: 1, completion: 1, request: 0 } } },
])(
  "rejects unsupported campaign controls before local auth, dispatch, or staged retry",
  async (controls) => {
    let called = false;
    const provider = localChatProvider(ollamaDeltas, {
      name: "local",
      root: "http://localhost:11434",
      model: "m",
      authHeaders: async () => {
        called = true;
        return {};
      },
      fetchFn: async () => {
        called = true;
        return new Response(null, { status: 400 });
      },
    });
    const iterator = provider
      .stream({ systemPrompt: "", messages: [], tools: [], ...controls })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toBeInstanceOf(ProviderRequestControlError);
    expect(called).toBe(false);
    expect(provider.requestSupport).toBeUndefined();
  },
);
