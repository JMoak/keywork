import { describe, expect, it } from "vitest";
import { bearerHeaders } from "../../../providers/transport.ts";
import { recorded, replaying, type SentRequest } from "../fixtures/cassette.ts";
import type { DecisionRequest } from "../types.ts";
import { systemOneDecider, systemOneUrl } from "./systemone.ts";

function requestOf(name: string): DecisionRequest {
  return recorded(name).request.body as DecisionRequest;
}

function deciderReplaying(name: string, sent: SentRequest[] = [], model = "nimble-9b-q8_0") {
  return systemOneDecider({
    reference: { provider: "spark", model },
    endpoint: "http://spark-ad4d:9931/v1",
    fetchFn: replaying(recorded(name), sent),
    clock: steppingClock(12),
  });
}

function steppingClock(stepMs: number): () => number {
  let now = 0;
  return () => {
    now += stepMs;
    return now;
  };
}

describe("systemOneDecider against recorded llama-server answers", () => {
  it("posts the trusted state and typed questions to /v1/systemone", async () => {
    const sent: SentRequest[] = [];
    await deciderReplaying("llama-server-mixed", sent).decide(requestOf("llama-server-mixed"));
    expect(sent).toHaveLength(1);
    expect(new URL(sent[0]?.url ?? "").pathname).toBe("/v1/systemone");
    expect(sent[0]?.body).toEqual(recorded("llama-server-mixed").request.body);
    expect(sent[0]?.headers["content-type"]).toBe("application/json");
    expect(sent[0]?.headers.authorization).toBeUndefined();
  });

  it("returns calibrated distributions with the leading answer's mass as confidence", async () => {
    const reply = await deciderReplaying("llama-server-mixed").decide(
      requestOf("llama-server-mixed"),
    );
    expect(reply).toEqual({
      ok: true,
      model: "nimble-9b-q8_0",
      answers: {
        destructive: { type: "noul", pYes: 0.91, confidence: 0.91 },
        intent: {
          type: "choice",
          choice: "publish",
          probabilities: { publish: 0.87, inspect: 0.02, cleanup: 0.11 },
          confidence: 0.87,
        },
        risk: {
          type: "score",
          score: 2.54,
          probabilities: [0.01, 0.05, 0.33, 0.61],
          confidence: 0.61,
        },
      },
      usage: { inputTokens: 412, questions: 3, cost: null },
      latencyMs: 12,
    });
  });

  it("records missing usage as null, never zero", async () => {
    const reply = await systemOneDecider({
      reference: { provider: "ollama", model: "nimble" },
      endpoint: "http://localhost:11434/v1",
      fetchFn: replaying(recorded("ollama-nimble-no-usage")),
    }).decide(requestOf("ollama-nimble-no-usage"));
    expect(reply).toMatchObject({
      ok: true,
      answers: { approve: { type: "noul", pYes: 0.18, confidence: expect.closeTo(0.82) } },
      usage: { inputTokens: null, questions: 1, cost: null },
    });
  });

  it("prices input tokens from a price table when the server reports no cost", async () => {
    const reply = await systemOneDecider({
      reference: { provider: "spark", model: "nimble-9b-q8_0" },
      endpoint: "http://spark-ad4d:9931/v1",
      fetchFn: replaying(recorded("llama-server-mixed")),
      pricePerMillionInput: 0.042,
    }).decide(requestOf("llama-server-mixed"));
    expect(reply).toMatchObject({
      ok: true,
      usage: { cost: { usd: (412 * 0.042) / 1e6, source: "price_table" } },
    });
  });

  it("sends the credential as a bearer header", async () => {
    const sent: SentRequest[] = [];
    await systemOneDecider({
      reference: { provider: "spark", model: "nimble-9b-q8_0" },
      endpoint: "http://spark-ad4d:9931/v1",
      authHeaders: bearerHeaders("sk-local"),
      fetchFn: replaying(recorded("llama-server-mixed"), sent),
    }).decide(requestOf("llama-server-mixed"));
    expect(sent[0]?.headers.authorization).toBe("Bearer sk-local");
  });
});

describe("systemOneDecider failures", () => {
  it("reports an unpulled Ollama model as model-not-found", async () => {
    const reply = await deciderReplaying("ollama-model-missing").decide(
      requestOf("ollama-model-missing"),
    );
    expect(reply).toMatchObject({
      ok: false,
      failure: { reason: "model-not-found", status: 404 },
    });
  });

  it("reports a 429 as rate-limited with the body as the message", async () => {
    const reply = await deciderReplaying("openrouter-rate-limited").decide(
      requestOf("openrouter-rate-limited"),
    );
    expect(reply).toMatchObject({
      ok: false,
      failure: { reason: "rate-limited", status: 429, message: expect.stringContaining("Rate") },
    });
  });

  it("refuses a distribution that does not sum to one", async () => {
    const reply = await deciderReplaying("probabilities-off").decide(
      requestOf("probabilities-off"),
    );
    expect(reply).toEqual({
      ok: false,
      failure: { reason: "malformed", message: "intent: probabilities sum to 0.7" },
    });
  });

  it("refuses a reply that leaves a question unanswered", async () => {
    const request = requestOf("llama-server-mixed");
    const extra: DecisionRequest = {
      ...request,
      questions: { ...request.questions, missing: { type: "noul", instructions: "?" } },
    };
    const reply = await deciderReplaying("llama-server-mixed").decide(extra);
    expect(reply).toEqual({
      ok: false,
      failure: { reason: "malformed", message: "missing: no answer" },
    });
  });

  it("refuses an answer of another type than the question asked", async () => {
    const request = requestOf("llama-server-mixed");
    const swapped: DecisionRequest = {
      ...request,
      questions: {
        ...request.questions,
        destructive: { type: "score", instructions: "?", criteria: ["a", "b"] },
      },
    };
    const reply = await deciderReplaying("llama-server-mixed").decide(swapped);
    expect(reply).toMatchObject({
      ok: false,
      failure: { reason: "malformed", message: "destructive: expected score, got noul" },
    });
  });

  it("reports a refused connection as unreachable", async () => {
    const reply = await systemOneDecider({
      reference: { provider: "ollama", model: "nimble" },
      endpoint: "http://localhost:11434/v1",
      fetchFn: async () => {
        throw new TypeError("fetch failed: ECONNREFUSED");
      },
    }).decide(requestOf("ollama-nimble-no-usage"));
    expect(reply).toEqual({
      ok: false,
      failure: { reason: "unreachable", message: "fetch failed: ECONNREFUSED" },
    });
  });

  it.each([
    [401, "refused"],
    [503, "saturated"],
    [529, "overloaded"],
    [502, "unreachable"],
    [400, "rejected"],
  ])("maps HTTP %i to %s", async (status, reason) => {
    const reply = await systemOneDecider({
      reference: { provider: "ollama", model: "nimble" },
      endpoint: "http://localhost:11434/v1",
      fetchFn: async () => new Response("{}", { status }),
    }).decide(requestOf("ollama-nimble-no-usage"));
    expect(reply).toMatchObject({ ok: false, failure: { reason, status } });
  });
});

describe("systemOneUrl", () => {
  it.each([
    ["http://localhost:11434/v1", "http://localhost:11434/v1/systemone"],
    ["http://localhost:11434/v1/", "http://localhost:11434/v1/systemone"],
    ["http://localhost:9931", "http://localhost:9931/v1/systemone"],
    ["https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1/systemone"],
  ])("places the route under %s", (endpoint, url) => {
    expect(systemOneUrl(endpoint)).toBe(url);
  });
});
