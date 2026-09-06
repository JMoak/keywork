import { describe, expect, it } from "vitest";
import type { Note } from "../notes.ts";
import type { ArcCloseCandidate, ArcReview } from "./airlock.ts";
import { ArcCloseDraft } from "./draft.ts";
import type { OpenQuestion } from "./questions.ts";

function candidate(name: string, eligible: boolean): ArcCloseCandidate {
  const note = { name, title: name } as Note;
  return { note, eligible, shortfalls: eligible ? [] : ["uncited"] };
}

function question(title: string): OpenQuestion {
  return { title } as OpenQuestion;
}

const review: ArcReview = {
  candidates: [candidate("Dock Ratio Finding", true), candidate("Uncited Hunch", false)],
  questions: [question("Tie order"), question("Theme drift")],
};

describe("ArcCloseDraft", () => {
  it("starts with every item undecided and reports them by name", () => {
    const draft = new ArcCloseDraft();
    expect(draft.undecided(review)).toEqual([
      "Dock Ratio Finding",
      "Uncited Hunch",
      "Tie order",
      "Theme drift",
    ]);
    expect(draft.decisions(review)).toEqual({ candidates: {}, questions: {} });
  });

  it("delivers the eligible candidates in one stroke and leaves the rest archived", () => {
    const draft = new ArcCloseDraft();
    expect(draft.deliverEligible(review.candidates)).toBe(1);
    expect(draft.candidateDecision("Dock Ratio Finding")).toBe("deliver");
    expect(draft.candidateDecision("Uncited Hunch")).toBe("leave");
    expect(draft.undecided(review)).toEqual(["Tie order", "Theme drift"]);
  });

  it("leaves below-bar candidates archived without touching the eligible ones", () => {
    const draft = new ArcCloseDraft();
    draft.leaveBelowBar(review.candidates);
    expect(draft.candidateDecision("Uncited Hunch")).toBe("leave");
    expect(draft.candidateDecision("Dock Ratio Finding")).toBeUndefined();
    expect(draft.undecided(review)).toEqual(["Dock Ratio Finding", "Tie order", "Theme drift"]);
  });

  it("carries the successor only when a question is carried", () => {
    const draft = new ArcCloseDraft();
    draft.decideQuestion("Tie order", "resolve", "next-arc");
    expect(draft.successorArc()).toBeUndefined();
    draft.decideQuestion("Theme drift", "carry", "next-arc");
    expect(draft.successorArc()).toBe("next-arc");
    draft.decideCandidate("Dock Ratio Finding", "leave");
    draft.decideCandidate("Uncited Hunch", "leave");
    expect(draft.undecided(review)).toEqual([]);
    expect(draft.decisions(review)).toEqual({
      candidates: { "Dock Ratio Finding": "leave", "Uncited Hunch": "leave" },
      questions: { "Tie order": "resolve", "Theme drift": "carry" },
      successor: "next-arc",
    });
  });

  it("forgets decisions about items the review no longer holds", () => {
    const draft = new ArcCloseDraft();
    draft.decideCandidate("Vanished", "deliver");
    draft.decideQuestion("Gone", "drop");
    expect(draft.decisions(review)).toEqual({ candidates: {}, questions: {} });
  });

  it("remembers the last acknowledgement sweep", () => {
    const draft = new ArcCloseDraft();
    expect(draft.lastSweep()).toBeUndefined();
    draft.recordSweep({ acked: ["s1"], wedged: ["s2"], forced: true });
    expect(draft.lastSweep()).toEqual({ acked: ["s1"], wedged: ["s2"], forced: true });
  });
});
