import { describe, expect, it } from "vitest";
import { ProviderEmptyStreamError, ProviderHttpError, ProviderStreamError } from "./errors.ts";

const fakeUserId = "user_2fAkE0000iD0000fAkE0000xx";

function messageOf(status: number, body: string, provider = "openrouter"): string {
  return new ProviderHttpError(provider, status, body).message;
}

describe("ProviderHttpError meanings", () => {
  it("reads a 401 as a rejected key and points at connect", () => {
    const body = '{"error":{"message":"User not found.","code":401}}';

    expect(messageOf(401, body)).toBe(
      "openrouter rejected the key · run keywork connect openrouter · (401) User not found.",
    );
  });

  it("reads OpenRouter's tool-use 404 as a model that can't call tools, without its advice", () => {
    const body = JSON.stringify({
      error: {
        message:
          'No endpoints found that support tool use. Try disabling "read". To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection',
        code: 404,
        metadata: { failed_routing_step: "Filter by Tool Compatibility" },
      },
    });

    const message = messageOf(404, body);

    expect(message).toBe(
      "this model can't call tools on openrouter · pick another one · (404) No endpoints found that support tool use.",
    );
    expect(message).not.toContain("Try disabling");
  });

  it("reads an unknown model id as unrecognized and drops the account id", () => {
    const body = `{"error":{"message":"acme/does-not-exist-9000 is not a valid model ID","code":400},"user_id":"${fakeUserId}"}`;

    expect(messageOf(400, body)).toBe(
      "openrouter didn't recognize the model id · (400) acme/does-not-exist-9000 is not a valid model ID",
    );
  });

  it("recognizes missing models in OpenAI and Ollama phrasing", () => {
    const openAi = JSON.stringify({
      error: {
        message: "The model `gpt-9` does not exist or you do not have access to it.",
        code: "model_not_found",
      },
    });
    const ollama = '{"error":"model \\"qwen9\\" not found, try pulling it first"}';

    expect(messageOf(404, openAi, "openai")).toBe(
      "openai didn't recognize the model id · (404) The model `gpt-9` does not exist or you do not have access to it.",
    );
    expect(messageOf(404, ollama, "ollama")).toBe(
      'ollama didn\'t recognize the model id · (404) model "qwen9" not found, try pulling it first',
    );
  });

  it("keeps the status alone when a known rejection arrives without a body", () => {
    expect(messageOf(401, "")).toBe(
      "openrouter rejected the key · run keywork connect openrouter · (401)",
    );
  });

  it("keeps the raw status and excerpt for failures it has no meaning for", () => {
    expect(messageOf(429, "quota exceeded", "test")).toBe(
      "test request failed (429): quota exceeded",
    );
    expect(messageOf(500, "x".repeat(600), "test")).toHaveLength(
      "test request failed (500): ".length + 500,
    );
  });
});

describe("account ids in surfaced provider text", () => {
  it("redacts id fields whatever their spelling", () => {
    const body = JSON.stringify({
      error: { message: "Provider returned error", code: 429 },
      user_id: fakeUserId,
      orgId: "org-1234",
      account_id: 98765,
    });

    const message = messageOf(429, body);

    expect(message).toContain('"user_id":"[redacted]"');
    expect(message).toContain('"orgId":"[redacted]"');
    expect(message).toContain('"account_id":"[redacted]"');
    expect(message).not.toContain(fakeUserId);
    expect(message).not.toContain("98765");
  });

  it("redacts id-shaped tokens that appear inside provider prose", () => {
    const body = `Rate limit reached for gpt-x in organization org-a1b2c3d4e5f6g7h8i9j0k1l2 for ${fakeUserId}.`;

    expect(messageOf(429, body, "openai")).toBe(
      "openai request failed (429): Rate limit reached for gpt-x in organization [redacted] for [redacted].",
    );
  });

  it("leaves ordinary words that merely start like an id alone", () => {
    const body = "user_interactions and org-level settings are fine";

    expect(messageOf(503, body, "test")).toBe(`test request failed (503): ${body}`);
  });

  it("redacts stream failures too", () => {
    const failure = new ProviderStreamError(
      "openrouter",
      `{"message":"boom","user_id":"${fakeUserId}"}`,
    );

    expect(failure.message).toBe(
      'openrouter stream failed: {"message":"boom","user_id":"[redacted]"}',
    );
  });
});

describe("ProviderEmptyStreamError", () => {
  it("is a transient stream failure", () => {
    const failure = new ProviderEmptyStreamError("openrouter");

    expect(failure).toBeInstanceOf(ProviderStreamError);
    expect(failure.transient).toBe(true);
    expect(failure.message).toBe(
      "openrouter stream failed: ended with no reply and no finish reason",
    );
  });
});
