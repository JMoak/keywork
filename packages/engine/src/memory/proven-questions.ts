import type { MemoryQuestion } from "./decider.ts";

export interface QuestionProof {
  readonly edition: string;
  readonly question: MemoryQuestion;
}

export const memoryEvalProofs: readonly QuestionProof[] = [];

export function deciderEdition(decider: string, version: string): string {
  return `${decider}-${version}`;
}

export function provenQuestions(
  edition: string,
  proofs: readonly QuestionProof[] = memoryEvalProofs,
): ReadonlySet<MemoryQuestion> {
  return new Set(
    proofs.filter((proof) => proof.edition === edition).map((proof) => proof.question),
  );
}

export function isQuestionProven(
  edition: string,
  question: MemoryQuestion,
  proofs: readonly QuestionProof[] = memoryEvalProofs,
): boolean {
  return provenQuestions(edition, proofs).has(question);
}
