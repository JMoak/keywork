import type {
  AckSweep,
  ArcCloseCandidate,
  ArcReview,
  CandidateTriage,
  CloseDecisions,
  QuestionTriage,
} from "./airlock.ts";

export class ArcCloseDraft {
  private readonly candidates = new Map<string, CandidateTriage>();
  private readonly questions = new Map<string, QuestionTriage>();
  private successor: string | undefined;
  private sweep: AckSweep | undefined;

  decideCandidate(name: string, triage: CandidateTriage): void {
    this.candidates.set(name, triage);
  }

  decideQuestion(title: string, triage: QuestionTriage, successor?: string): void {
    this.questions.set(title, triage);
    if (triage === "carry" && successor !== undefined) this.successor = successor;
  }

  deliverEligible(candidates: readonly ArcCloseCandidate[]): number {
    let delivered = 0;
    for (const candidate of candidates) {
      this.candidates.set(candidate.note.name, candidate.eligible ? "deliver" : "leave");
      if (candidate.eligible) delivered += 1;
    }
    return delivered;
  }

  leaveBelowBar(candidates: readonly ArcCloseCandidate[]): void {
    for (const candidate of candidates) {
      if (!candidate.eligible) this.candidates.set(candidate.note.name, "leave");
    }
  }

  recordSweep(sweep: AckSweep): void {
    this.sweep = sweep;
  }

  lastSweep(): AckSweep | undefined {
    return this.sweep;
  }

  candidateDecision(name: string): CandidateTriage | undefined {
    return this.candidates.get(name);
  }

  questionDecision(title: string): QuestionTriage | undefined {
    return this.questions.get(title);
  }

  successorArc(): string | undefined {
    return this.successor;
  }

  undecided(review: ArcReview): string[] {
    return [
      ...review.candidates
        .map((candidate) => candidate.note.name)
        .filter((name) => !this.candidates.has(name)),
      ...review.questions
        .map((question) => question.title)
        .filter((title) => !this.questions.has(title)),
    ];
  }

  decisions(review: ArcReview): CloseDecisions {
    const named = new Set(review.candidates.map((candidate) => candidate.note.name));
    const titled = new Set(review.questions.map((question) => question.title));
    return {
      candidates: Object.fromEntries([...this.candidates].filter(([name]) => named.has(name))),
      questions: Object.fromEntries([...this.questions].filter(([title]) => titled.has(title))),
      ...(this.successor !== undefined && { successor: this.successor }),
    };
  }
}
