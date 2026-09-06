import { describe, expect, it } from "vitest";
import type { Provider, ProviderRequest, TurnDelta } from "../../provider.ts";
import type { DailyEntryCandidate } from "../gardener.ts";
import type { Note } from "../notes.ts";
import { closingJudgment } from "./closing.ts";

const entries: DailyEntryCandidate[] = [
  {
    id: "2026-08-16#0",
    date: "2026-08-16",
    time: "09:00",
    provenance: "agent",
    text: "dock chrome uses the theme ramp",
  },
];

const notePair: [Note, Note] = [
  { name: "A", title: "A", body: "docks split 50/50\n" } as Note,
  { name: "B", title: "B", body: "docks split 60/40\n" } as Note,
];

function replying(reply: string, seen: ProviderRequest[] = []): Provider {
  return {
    name: "mock",
    async *stream(request): AsyncIterable<TurnDelta> {
      seen.push(request);
      yield { type: "text", text: reply };
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}

function throwing(): Provider {
  return {
    name: "mock",
    stream(): AsyncIterable<TurnDelta> {
      throw new Error("provider unreachable");
    },
  };
}

describe("closingJudgment promotions", () => {
  it("parses proposals out of a chatty reply and clamps confidence", async () => {
    const reply =
      'Here you go:\n[{"entryId": "2026-08-16#0", "title": "Dock Chrome", "body": "ramp\\n", "confidence": 1.7}]';
    const judgment = closingJudgment({ provider: replying(reply) });
    expect(await judgment.proposePromotions(entries)).toEqual([
      { entryId: "2026-08-16#0", title: "Dock Chrome", body: "ramp\n", confidence: 1 },
    ]);
  });

  it("drops malformed proposals and survives non-JSON replies", async () => {
    const reply = '[{"entryId": 3, "title": "Bad"}, {"noise": true}]';
    expect(await closingJudgment({ provider: replying(reply) }).proposePromotions(entries)).toEqual(
      [],
    );
    expect(
      await closingJudgment({ provider: replying("no json here") }).proposePromotions(entries),
    ).toEqual([]);
  });

  it("puts the direction into the instruction so the model is steered", async () => {
    const seen: ProviderRequest[] = [];
    const judgment = closingJudgment({
      provider: replying("[]", seen),
      direction: "keep only the dock rules",
    });
    await judgment.proposePromotions(entries);
    await judgment.classifyPair(...notePair);
    for (const request of seen) {
      expect(request.systemPrompt).toContain(
        'steered the distillation: "keep only the dock rules"',
      );
    }
  });

  it("asks nothing of the provider when there are no entries", async () => {
    const seen: ProviderRequest[] = [];
    expect(await closingJudgment({ provider: replying("[]", seen) }).proposePromotions([])).toEqual(
      [],
    );
    expect(seen).toEqual([]);
  });
});

describe("closingJudgment pair verdicts", () => {
  it("parses a verdict and falls back to distinct on garbage", async () => {
    const verdict = await closingJudgment({
      provider: replying('{"relation": "duplicate", "confidence": 0.9, "keep": "a"}'),
    }).classifyPair(...notePair);
    expect(verdict).toEqual({ relation: "duplicate", confidence: 0.9, keep: "a" });
    expect(
      await closingJudgment({ provider: replying("shrug") }).classifyPair(...notePair),
    ).toEqual({ relation: "distinct", confidence: 0 });
    expect(
      await closingJudgment({ provider: replying('{"relation": "sideways"}') }).classifyPair(
        ...notePair,
      ),
    ).toEqual({ relation: "distinct", confidence: 0 });
  });
});

describe("closingJudgment degradation", () => {
  it("reports one degrade for a throwing provider and answers inertly from then on", async () => {
    const reasons: string[] = [];
    const judgment = closingJudgment({
      provider: throwing(),
      onDegrade: (reason) => reasons.push(reason),
    });
    expect(await judgment.proposePromotions(entries)).toEqual([]);
    expect(await judgment.classifyPair(...notePair)).toEqual({
      relation: "distinct",
      confidence: 0,
    });
    expect(await judgment.proposePromotions(entries)).toEqual([]);
    expect(reasons).toEqual(["provider unreachable"]);
  });
});
