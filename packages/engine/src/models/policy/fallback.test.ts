import { describe, expect, it } from "vitest";
import { type CallFailure, classifyFailure, type FailureVerdict, localityOf } from "./index.ts";

describe("classifyFailure", () => {
  const cases: ReadonlyArray<[string, CallFailure, FailureVerdict]> = [
    ["429", { status: 429 }, { kind: "fallback", trigger: "rate-limited" }],
    ["Ollama's full queue", { status: 503 }, { kind: "fallback", trigger: "saturated" }],
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
