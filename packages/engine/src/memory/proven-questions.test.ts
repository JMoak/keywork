import { describe, expect, it } from "vitest";
import { memoryQuestions } from "./decider.ts";
import {
  isQuestionProven,
  memoryEvalProofs,
  provenQuestions,
  type QuestionProof,
} from "./proven-questions.ts";

const proofs: QuestionProof[] = [
  { edition: "jev-1.13.0", question: memoryQuestions.actionRelevance },
  { edition: "jev-1.13.0", question: memoryQuestions.driftVerdict },
  { edition: "jev-1.14.0", question: memoryQuestions.pairRelation },
];

describe("provenQuestions", () => {
  it("starts empty: nothing is proven until a K15 report is checked in", () => {
    expect(memoryEvalProofs).toEqual([]);
    expect(provenQuestions("jev-1.13.0").size).toBe(0);
  });

  it("answers per edition, never across model versions", () => {
    expect([...provenQuestions("jev-1.13.0", proofs)]).toEqual([
      "action-relevance@1",
      "drift-verdict@1",
    ]);
    expect([...provenQuestions("jev-1.14.0", proofs)]).toEqual(["pair-relation@1"]);
    expect(isQuestionProven("jev-1.13.0", memoryQuestions.pairRelation, proofs)).toBe(false);
    expect(isQuestionProven("jev-1.14.0", memoryQuestions.pairRelation, proofs)).toBe(true);
  });
});
