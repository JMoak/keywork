import { describe, expect, it } from "vitest";
import { resolveProvider } from "./provider.ts";

describe("resolveProvider", () => {
  it("returns nothing when no keys are set", () => {
    expect(resolveProvider({})).toBeUndefined();
  });

  it("prefers OpenRouter and applies its default model", () => {
    const resolved = resolveProvider({ OPENROUTER_API_KEY: "k", OPENAI_API_KEY: "k2" });
    expect(resolved?.label).toBe("openrouter/openai/gpt-5-mini");
  });

  it("falls back to OpenAI", () => {
    const resolved = resolveProvider({ OPENAI_API_KEY: "k" });
    expect(resolved?.label).toBe("openai/gpt-5-mini");
  });

  it("honors an explicit model choice", () => {
    const resolved = resolveProvider({ OPENAI_API_KEY: "k" }, "gpt-5");
    expect(resolved?.label).toBe("openai/gpt-5");
  });

  it("ignores empty key values", () => {
    expect(resolveProvider({ OPENROUTER_API_KEY: "" })).toBeUndefined();
  });

  it("accepts KEYWORK_-prefixed keys, preferring them over unprefixed", () => {
    const resolved = resolveProvider({ KEYWORK_OPENROUTER_API_KEY: "scoped" });
    expect(resolved?.label).toBe("openrouter/openai/gpt-5-mini");
  });

  it("falls back to keys saved by keywork setup", () => {
    const resolved = resolveProvider({}, undefined, { openrouter: "saved-key" });
    expect(resolved?.label).toBe("openrouter/openai/gpt-5-mini");
  });

  it("lets environment variables outrank saved keys", () => {
    const resolved = resolveProvider({ KEYWORK_OPENAI_API_KEY: "env" }, undefined, {
      openrouter: "",
    });
    expect(resolved?.label).toBe("openai/gpt-5-mini");
  });
});
