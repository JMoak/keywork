import { describe, expect, it } from "vitest";
import type { ProviderRegistration } from "../../inference/types.ts";
import { blankRecord } from "../capabilities/index.ts";
import {
  type CallFailure,
  classifyFailure,
  type FailureVerdict,
  localityOf,
  nextCandidate,
  type PlannedCandidate,
  type PolicyPlan,
} from "./index.ts";

describe("classifyFailure", () => {
  const cases: ReadonlyArray<[string, CallFailure, FailureVerdict]> = [
    ["429", { status: 429 }, { kind: "fallback", trigger: "rate-limited" }],
    ["Ollama's full queue", { status: 503 }, { kind: "fallback", trigger: "saturated" }],
    ["a gateway error", { status: 502 }, { kind: "fallback", trigger: "down" }],
    ["a server crash", { status: 500 }, { kind: "fallback", trigger: "down" }],
    ["a refused connection", { message: "ECONNREFUSED" }, { kind: "fallback", trigger: "down" }],
    [
      "OpenAI's context error",
      { status: 400, code: "context_length_exceeded" },
      { kind: "fallback", trigger: "context-length" },
    ],
    [
      "Anthropic's long prompt",
      { status: 400, message: "prompt is too long: 210000 tokens > 200000 maximum" },
      { kind: "fallback", trigger: "context-length" },
    ],
    [
      "OpenRouter's moderation",
      { status: 403, message: "Input was flagged by moderation" },
      { kind: "fallback", trigger: "moderation" },
    ],
    ["a missing route", { status: 404 }, { kind: "terminal", reason: "model-not-found" }],
    [
      "Ollama's unpulled model",
      { status: 400, message: 'model "qwen3.8-27b" not found, try pulling it first' },
      { kind: "terminal", reason: "model-not-found" },
    ],
    [
      "OpenAI's model_not_found",
      { status: 400, code: "model_not_found" },
      { kind: "terminal", reason: "model-not-found" },
    ],
    [
      "OpenRouter's invalid id",
      { status: 400, message: "qwen/nope is not a valid model ID" },
      { kind: "terminal", reason: "model-not-found" },
    ],
    ["a refused key", { status: 401 }, { kind: "terminal", reason: "credential-refused" }],
    [
      "a malformed request",
      { status: 422, message: "bad field" },
      { kind: "terminal", reason: "request-rejected" },
    ],
  ];

  it.each(cases)("classifies %s", (_, failure, verdict) => {
    expect(classifyFailure(failure)).toEqual(verdict);
  });
});

describe("nextCandidate", () => {
  const plan: PolicyPlan = {
    modelClass: "loop",
    candidates: [
      planned("ollama", "http://localhost:11434/v1", "qwen3.6-35b-a3b"),
      planned("spark", "http://spark-ad4d:9931/v1", "qwen3.6-35b-a3b"),
      planned("openrouter", "https://openrouter.ai/api/v1", "qwen/qwen3.6-35b-a3b"),
    ],
    refused: [],
    localOnly: true,
  };

  it("moves to the next candidate on a fallback trigger", () => {
    const step = nextCandidate({
      plan,
      current: 0,
      failure: { status: 503 },
      streamed: "nothing",
    });
    expect(step).toMatchObject({ kind: "next", index: 1, trigger: "saturated" });
    expect(step).not.toHaveProperty("cloudFallback");
  });

  it("logs a fallback that leaves the creature's machines for the cloud", () => {
    const step = nextCandidate({
      plan,
      current: 1,
      failure: { status: 429 },
      streamed: "nothing",
    });
    expect(step).toMatchObject({
      kind: "next",
      index: 2,
      cloudFallback: {
        from: { provider: "spark", model: "qwen3.6-35b-a3b" },
        to: { provider: "openrouter", model: "qwen/qwen3.6-35b-a3b" },
        trigger: "rate-limited",
      },
    });
  });

  it("never fails over mid-stream once a tool call was emitted", () => {
    const step = nextCandidate({
      plan,
      current: 0,
      failure: { status: 503 },
      streamed: "tool-call",
    });
    expect(step).toEqual({ kind: "stop", reason: "tool-call-emitted" });
  });

  it("never splices a second model onto a reply the first one started", () => {
    const step = nextCandidate({ plan, current: 0, failure: { status: 503 }, streamed: "text" });
    expect(step).toEqual({ kind: "stop", reason: "partial-reply" });
  });

  it("stops on model-not-found instead of trying another model", () => {
    const step = nextCandidate({
      plan,
      current: 0,
      failure: { status: 404 },
      streamed: "nothing",
    });
    expect(step).toEqual({ kind: "stop", reason: "model-not-found" });
  });

  it("stops when the candidates run out", () => {
    const step = nextCandidate({ plan, current: 2, failure: {}, streamed: "nothing" });
    expect(step).toEqual({ kind: "stop", reason: "exhausted" });
  });
});

describe("localityOf", () => {
  it.each([
    ["http://localhost:11434/v1", "local"],
    ["http://127.0.0.1:9931/v1", "local"],
    ["http://100.88.12.4:9931/v1", "local"],
    ["http://[fd7a:115c:a1e0::1]:9931/v1", "local"],
    ["http://192.168.1.20:1234/v1", "local"],
    ["http://spark-ad4d:9931/v1", "local"],
    ["https://spark-ad4d.tail1234.ts.net/v1", "local"],
    ["https://openrouter.ai/api/v1", "cloud"],
    ["http://100.128.0.1/v1", "cloud"],
    ["us-east-1", "cloud"],
  ])("places %s in the %s", (endpoint, locality) => {
    expect(localityOf(endpoint)).toBe(locality);
  });
});

function planned(name: string, endpoint: string, model: string): PlannedCandidate {
  const registration: ProviderRegistration = {
    name,
    protocol: "chat-completions",
    endpoint,
    credential: { kind: "none" },
    models: [],
    openCatalog: true,
    enabled: true,
  };
  const server = { id: name, kind: "ollama", version: "0.40.14", build: null, routes: [] } as const;
  return {
    level: "creature",
    locality: localityOf(endpoint),
    capabilities: blankRecord(endpoint, model, server, "2026-11-05"),
    binding: {
      reference: { provider: name, model },
      registration,
      spec: { id: model, origin: "unlisted" },
      protocol: "chat-completions",
      capabilities: { input: ["text"], toolCalls: true },
      credential: undefined,
    },
  };
}
