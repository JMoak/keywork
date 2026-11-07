import { describe, expect, it } from "vitest";
import { bearerHeaders } from "../../../providers/transport.ts";
import { recorded, replaying, type SentRequest } from "../fixtures/cassette.ts";
import type { DecisionRequest } from "../types.ts";
import { jevTextLimitBytes, jevViaOpenRouter, UnpinnedDecisionModelError } from "./jev.ts";

const entry = recorded("openrouter-jev-1.14");
const request = entry.request.body as DecisionRequest;

describe("jevViaOpenRouter", () => {
  it("asks pinned Jev 1.14 on OpenRouter's System One route with the key as a bearer", async () => {
    const sent: SentRequest[] = [];
    const jev = jevViaOpenRouter({
      authHeaders: bearerHeaders("sk-or-test"),
      fetchFn: replaying(entry, sent),
    });
    const reply = await jev.decide(request);
    expect(jev.reference).toEqual({ provider: "openrouter", model: "typesafe/jev-1.14" });
    expect(sent[0]?.url).toBe("https://openrouter.ai/api/v1/systemone");
    expect(sent[0]?.headers.authorization).toBe("Bearer sk-or-test");
    expect(sent[0]?.body).toEqual(entry.request.body);
    expect(reply).toMatchObject({
      ok: true,
      model: "typesafe/jev-1.14",
      answers: { approve: { type: "noul", pYes: 0.07 } },
      usage: { inputTokens: 318, questions: 1, cost: { usd: 0.0000134, source: "provider" } },
    });
  });

  it("refuses a moving alias, because thresholds belong to one version", () => {
    for (const model of ["~typesafe/jev-latest", "jev-latest"]) {
      expect(() => jevViaOpenRouter({ authHeaders: bearerHeaders("k"), model })).toThrow(
        UnpinnedDecisionModelError,
      );
    }
  });

  it("refuses a request over the short-context limit without sending it", async () => {
    const sent: SentRequest[] = [];
    const jev = jevViaOpenRouter({
      authHeaders: bearerHeaders("k"),
      fetchFn: replaying(entry, sent),
    });
    const reply = await jev.decide({ ...request, state: "x".repeat(jevTextLimitBytes) });
    expect(sent).toEqual([]);
    expect(reply).toMatchObject({ ok: false, failure: { reason: "oversize" } });
  });
});
