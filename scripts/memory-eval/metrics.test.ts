import { describe, expect, it } from "vitest";
import { memoryQuestions } from "../../packages/engine/src/index.ts";
import { answersOf, disagreements, measureQuestion, questionsIn } from "./metrics.ts";
import {
  actionPoint,
  answers,
  candidate,
  corpusOf,
  entryPoint,
  keeps,
  relevant,
  verdict,
} from "./test-corpus.ts";

const auth = actionPoint("auth", ["Auth Tokens", "Release Pipeline", "Theme Tokens"], { rides: 3 });
const lint = actionPoint("lint", ["Biome Lint", "Package Manager"], {
  rides: 1,
  candidates: [
    candidate("Biome Lint", { tokens: 40 }),
    candidate("Package Manager", { tokens: 60 }),
  ],
});
const labels = [
  relevant("auth", "Auth Tokens"),
  relevant("auth", "Release Pipeline", false),
  relevant("auth", "Theme Tokens", false),
  relevant("lint", "Biome Lint"),
  relevant("lint", "Package Manager", false),
];
const corpus = corpusOf([auth, lint], labels);
const builtin = answersOf([
  keeps(auth, ["Auth Tokens", "Release Pipeline", "Theme Tokens"], {
    decider: "builtin",
    latencyMs: 0,
  }),
  keeps(lint, ["Biome Lint", "Package Manager"], { decider: "builtin", latencyMs: 0 }),
]);

describe("measureQuestion for action recall", () => {
  it("counts tokens injected and carried for the turns each injection rides", () => {
    const measures = measureQuestion(memoryQuestions.actionRelevance, corpus, builtin);
    expect(measures.points).toBe(2);
    expect(measures.injection).toEqual({ injected: 300 + 100, carried: 300 * 3 + 100 * 1 });
  });

  it("reports hindsight recall and precision over labeled candidates", () => {
    const measures = measureQuestion(memoryQuestions.actionRelevance, corpus, builtin);
    expect(measures.hindsight).toMatchObject({
      relevant: 2,
      kept: 5,
      keptRelevant: 2,
      recall: 1,
      precision: 0.4,
    });
    expect(measures.hindsight?.harmful).toBeUndefined();
  });

  it("names each harmful drop: relevant, kept by the builtin, dropped by the challenger", () => {
    const challenger = answersOf([keeps(auth, ["Auth Tokens"]), keeps(lint, ["Package Manager"])]);
    const measures = measureQuestion(memoryQuestions.actionRelevance, corpus, challenger, builtin);
    expect(measures.hindsight).toMatchObject({ recall: 0.5, precision: 0.5 });
    expect(measures.hindsight?.harmful).toEqual({
      count: 1,
      rate: 0.5,
      drops: [{ point: "lint", note: "Biome Lint" }],
    });
  });

  it("lets a hand label overrule hindsight, and reports judge-rated quality only with judge labels", () => {
    const overruled = corpusOf(
      [auth, lint],
      [...labels, relevant("auth", "Release Pipeline", true, "hand")],
    );
    const measures = measureQuestion(memoryQuestions.actionRelevance, overruled, builtin);
    expect(measures.hindsight?.relevant).toBe(3);
    expect(measures.judged).toBeUndefined();
    const judged = corpusOf(
      [auth, lint],
      [...labels, relevant("auth", "Theme Tokens", true, "judge")],
    );
    expect(measureQuestion(memoryQuestions.actionRelevance, judged, builtin).judged).toMatchObject({
      relevant: 1,
      keptRelevant: 1,
    });
  });

  it("leaves screened candidates out: already surfaced or superseded is never the decider's call", () => {
    const screened = actionPoint("screened", ["Auth Tokens", "Old Auth"], {
      surfaced: ["Auth Tokens"],
      candidates: [candidate("Auth Tokens"), candidate("Old Auth", { superseded: true })],
    });
    const measures = measureQuestion(
      memoryQuestions.actionRelevance,
      corpusOf([screened], [relevant("screened", "Auth Tokens"), relevant("screened", "Old Auth")]),
      answersOf([keeps(screened, [])]),
    );
    expect(measures.hindsight).toMatchObject({ relevant: 0, recall: undefined });
  });

  it("measures only the held-out half", () => {
    const fitted = actionPoint("fitted", ["Auth Tokens"], { half: "fit" });
    const measures = measureQuestion(
      memoryQuestions.actionRelevance,
      corpusOf([auth, fitted], labels),
      builtin,
    );
    expect(measures.points).toBe(1);
  });

  it("spreads latency and hot-path wait, counts fallbacks and prices decider input", () => {
    const challenger = answersOf([
      keeps(auth, ["Auth Tokens"], { latencyMs: 300, waitedMs: 20, inputTokens: 1500 }),
      keeps(lint, ["Biome Lint"], {
        latencyMs: 100,
        inputTokens: 500,
        fallback: { reason: "late" },
      }),
    ]);
    const measures = measureQuestion(memoryQuestions.actionRelevance, corpus, challenger, builtin);
    expect(measures.latency).toEqual({ p50: 100, p95: 300, max: 300 });
    expect(measures.waited).toEqual({ p50: 20, p95: 100, max: 100 });
    expect(measures.fallbacks).toEqual([{ reason: "late", count: 1 }]);
    expect(measures.cost.inputTokens).toBe(2000);
    expect(measures.cost.usd).toBeCloseTo(2000 * 0.042e-6, 15);
  });

  it("calibrates per-candidate odds: the map is fitted on the fit half and judged on the held-out half", () => {
    const fitPoint = actionPoint("fit", ["A", "B"], { half: "fit" });
    const heldPoint = actionPoint("held", ["A", "B"]);
    const scored = (point: typeof fitPoint) => keeps(point, ["A"], { scores: { A: 0.9, B: 0.9 } });
    const measures = measureQuestion(
      memoryQuestions.actionRelevance,
      corpusOf(
        [fitPoint, heldPoint],
        [
          relevant("fit", "A"),
          relevant("fit", "B", false),
          relevant("held", "A"),
          relevant("held", "B", false),
        ],
      ),
      answersOf([scored(fitPoint), scored(heldPoint)]),
    );
    expect(measures.calibration).toMatchObject({ samples: 2, rawEce: expect.closeTo(0.4, 10) });
    expect(measures.calibration?.map).toEqual([{ upTo: 0.9, calibrated: 0.5 }]);
    expect(measures.calibration?.ece).toBeCloseTo(0, 10);
  });

  it("has no calibration for a decider that states no odds", () => {
    expect(
      measureQuestion(memoryQuestions.actionRelevance, corpus, builtin).calibration,
    ).toBeUndefined();
  });
});

describe("measureQuestion for curation", () => {
  const durable = entryPoint("2026-10-08#1");
  const episodic = entryPoint("2026-10-09#0");
  const unlabeled = entryPoint("2026-10-09#1");
  const curation = corpusOf(
    [durable, episodic, unlabeled],
    [
      verdict("2026-10-08#1", "new-durable"),
      verdict("2026-10-08#1", "episodic", true, "inbox"),
      verdict("2026-10-09#0", "new-durable", false, "inbox"),
    ],
  );

  it("agrees with the highest-ranked source's verdicts, a refusal counting as a verdict", () => {
    const measures = measureQuestion(
      memoryQuestions.entryDurability,
      curation,
      answersOf([
        answers(durable, "new-durable"),
        answers(episodic, "episodic"),
        answers(unlabeled, "unsure"),
      ]),
    );
    expect(measures.agreement).toEqual({ labeled: 2, agreed: 2, rate: 1 });
    expect(measures.injection).toBeUndefined();
    expect(measures.waited).toBeUndefined();
  });

  it("does not credit an answer the person refused", () => {
    const measures = measureQuestion(
      memoryQuestions.entryDurability,
      curation,
      answersOf([answers(durable, "unsure"), answers(episodic, "new-durable")]),
    );
    expect(measures.agreement).toEqual({ labeled: 2, agreed: 0, rate: 0 });
  });

  it("calibrates a choice by its stated confidence against agreement", () => {
    const fit = entryPoint("fit", "fit");
    const measures = measureQuestion(
      memoryQuestions.entryDurability,
      corpusOf(
        [fit, durable],
        [verdict("fit", "episodic"), verdict("2026-10-08#1", "new-durable")],
      ),
      answersOf([
        answers(fit, "new-durable", { confidence: 0.8 }),
        answers(durable, "new-durable", { confidence: 0.8 }),
      ]),
    );
    expect(measures.calibration).toMatchObject({ samples: 1, rawEce: expect.closeTo(0.2, 10) });
  });
});

describe("disagreements and questionsIn", () => {
  it("lists every point where two arms chose differently, in corpus order", () => {
    const challenger = answersOf([
      keeps(auth, ["Auth Tokens"]),
      keeps(lint, ["Biome Lint", "Package Manager"]),
    ]);
    expect(disagreements([auth, lint], challenger, builtin)).toEqual([
      {
        point: "auth",
        subject: "edit src/auth.ts",
        ours: "kept [[Auth Tokens]]",
        theirs: "kept [[Auth Tokens]], [[Release Pipeline]], [[Theme Tokens]]",
      },
    ]);
  });

  it("lists the corpus's questions in catalog order", () => {
    expect(questionsIn(corpusOf([entryPoint("e"), auth]))).toEqual([
      "action-relevance@1",
      "entry-durability@1",
    ]);
  });
});
