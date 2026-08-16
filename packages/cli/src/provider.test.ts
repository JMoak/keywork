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

  it("resolves keys saved by keywork setup", () => {
    const resolved = resolveProvider({}, undefined, {
      openrouter: { type: "api_key", key: "saved-key" },
    });
    expect(resolved?.label).toBe("openrouter/openai/gpt-5-mini");
  });

  it("ignores saved keys for providers outside the hard-coded catalog", () => {
    expect(
      resolveProvider({}, undefined, { attacker: { type: "api_key", key: "planted-key" } }),
    ).toBeUndefined();
  });

  it("lets saved keys outrank ambient environment variables, even across providers", () => {
    const resolved = resolveProvider({ OPENROUTER_API_KEY: "ambient" }, undefined, {
      openai: { type: "api_key", key: "saved" },
    });
    expect(resolved?.label).toBe("openai/gpt-5-mini");
  });

  it("lets KEYWORK_-scoped variables outrank saved keys", () => {
    const resolved = resolveProvider({ KEYWORK_OPENAI_API_KEY: "scoped" }, undefined, {
      openrouter: { type: "api_key", key: "" },
    });
    expect(resolved?.label).toBe("openai/gpt-5-mini");
  });

  it("resolves a ChatGPT subscription sign-in to the codex provider", () => {
    const resolved = resolveProvider({}, undefined, {
      "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 9e15 },
    });
    expect(resolved?.label).toBe("openai-codex/gpt-5.5");
  });

  it("honors an explicit model choice on the codex provider", () => {
    const resolved = resolveProvider({}, "gpt-5.4-mini", {
      "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 9e15 },
    });
    expect(resolved?.label).toBe("openai-codex/gpt-5.4-mini");
  });

  it("prefers a saved API key over the codex subscription", () => {
    const resolved = resolveProvider({}, undefined, {
      openrouter: { type: "api_key", key: "saved" },
      "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 9e15 },
    });
    expect(resolved?.label).toBe("openrouter/openai/gpt-5-mini");
  });

  it("prefers the codex sign-in over an ambient environment key", () => {
    const resolved = resolveProvider({ OPENAI_API_KEY: "ambient" }, undefined, {
      "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 9e15 },
    });
    expect(resolved?.label).toBe("openai-codex/gpt-5.5");
  });

  it("resolves bedrock from AWS credentials and region in the environment", () => {
    const resolved = resolveProvider({
      AWS_ACCESS_KEY_ID: "id",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_REGION: "us-east-1",
    });
    expect(resolved?.label).toBe("bedrock/amazon.nova-lite-v1:0");
  });

  it("falls back to the configured bedrock region when the environment has none", () => {
    const resolved = resolveProvider(
      { AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "secret" },
      undefined,
      undefined,
      "eu-west-1",
    );
    expect(resolved?.label).toBe("bedrock/amazon.nova-lite-v1:0");
  });

  it("returns nothing for AWS credentials without any region", () => {
    expect(
      resolveProvider({ AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "secret" }),
    ).toBeUndefined();
  });

  it("returns nothing for a region without complete AWS credentials", () => {
    expect(resolveProvider({ AWS_ACCESS_KEY_ID: "id", AWS_REGION: "us-east-1" })).toBeUndefined();
  });

  it("lets API-key providers outrank bedrock", () => {
    const resolved = resolveProvider({
      OPENAI_API_KEY: "k",
      AWS_ACCESS_KEY_ID: "id",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_REGION: "us-east-1",
    });
    expect(resolved?.label).toBe("openai/gpt-5-mini");
  });

  it("honors an explicit model choice on bedrock", () => {
    const resolved = resolveProvider(
      {
        AWS_ACCESS_KEY_ID: "id",
        AWS_SECRET_ACCESS_KEY: "secret",
        AWS_REGION: "us-east-1",
      },
      "meta.llama3-70b-instruct-v1:0",
    );
    expect(resolved?.label).toBe("bedrock/meta.llama3-70b-instruct-v1:0");
  });
});
