import { type ArcRecord, type ArcStatus, kebabTitle, validateArcSlug } from "@keywork/engine";
import { toError } from "@keywork/shared";
import { arcAnchor } from "./chroma.ts";
import { pluralize } from "./pluralize.ts";
import type { Theme } from "./theme.ts";

export type { ArcStatus };

export type ArcSummary = Pick<ArcRecord, "slug" | "status" | "created"> & { sessions: number };

export type ArcCloseOutcome =
  | { kind: "closed"; delivered: number; released: number; notice?: string }
  | { kind: "pending"; candidates: number; questions: number; wedged: number; notice?: string };

export type AirlockFinishOutcome =
  | ArcCloseOutcome
  | { kind: "undecided"; items: string[] }
  | { kind: "wedged"; sessions: string[] };

export type CandidateChoice = "deliver" | "leave";
export type QuestionChoice = "resolve" | "carry" | "drop";

export interface AirlockCandidateView {
  note: string;
  title: string;
  provenance: "user" | "agent" | "untrusted";
  eligible: boolean;
  shortfalls: string[];
  created?: string;
  choice?: CandidateChoice;
}

export interface AirlockQuestionView {
  title: string;
  provenance: "user" | "agent" | "untrusted";
  created?: string;
  choice?: QuestionChoice;
}

export interface AirlockSweepView {
  acked: number;
  wedged: number;
}

export interface AirlockDigestView {
  arc: string;
  candidates: AirlockCandidateView[];
  questions: AirlockQuestionView[];
  successor?: string;
  sweep?: AirlockSweepView;
  direction?: string;
}

export interface ArcAirlockPort {
  digest(slug: string): Promise<AirlockDigestView | undefined>;
  triageCandidate(slug: string, note: string, choice: CandidateChoice): Promise<void>;
  triageQuestion(slug: string, title: string, choice: QuestionChoice): Promise<void>;
  deliverEligible(slug: string): Promise<number>;
  finish(slug: string, options?: { force?: boolean }): Promise<AirlockFinishOutcome>;
}

export interface ArcsPort {
  list(): Promise<ArcSummary[]>;
  create(slug: string): Promise<ArcSummary>;
  close(slug: string, direction?: string): Promise<ArcCloseOutcome>;
  abandon(slug: string): Promise<void>;
  subscribe?(listener: () => void): () => void;
  returnDelta?(slug: string): Promise<string[]>;
  airlock?: ArcAirlockPort;
}

export type ArcOrdinals = (slug: string) => number | undefined;

export function arcOrdinalsOf(arcs: readonly ArcSummary[]): ArcOrdinals {
  const ordered = [...arcs].sort(byCreation);
  const ordinals = new Map(ordered.map((arc, ordinal) => [arc.slug, ordinal]));
  return (slug) => ordinals.get(slug);
}

export function arcInk(theme: Theme, ordinal: number | undefined): string {
  return ordinal === undefined ? theme.textDim : arcAnchor(theme.ramp, ordinal);
}

export function arcTag(slug: string): string {
  return `#${slug}`;
}

export function isArcSlug(candidate: string): boolean {
  return arcSlugProblem(candidate) === undefined;
}

export function arcSlugProblem(candidate: string): string | undefined {
  try {
    validateArcSlug(candidate);
    return undefined;
  } catch (cause) {
    return toError(cause).message;
  }
}

export function suggestArcSlug(title: string | undefined, taken: readonly string[]): string {
  const fromTitle = title === undefined ? undefined : kebabTitle(title);
  if (fromTitle !== undefined && isArcSlug(fromTitle) && !taken.includes(fromTitle)) {
    return fromTitle;
  }
  for (let ordinal = taken.length + 1; ; ordinal += 1) {
    const candidate = `arc-${ordinal}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

export function activeFirst(arcs: readonly ArcSummary[]): ArcSummary[] {
  return [...arcs].sort((left, right) => {
    if (left.status !== right.status) return left.status === "active" ? -1 : 1;
    return byCreation(right, left);
  });
}

export function describeCloseOutcome(slug: string, outcome: ArcCloseOutcome): string {
  const noted = (text: string): string =>
    outcome.notice === undefined ? text : `${text} · ${outcome.notice}`;
  if (outcome.kind === "closed") {
    const released =
      outcome.released === 0 ? "" : ` · ${pluralize(outcome.released, "session")} released`;
    return noted(
      `arc ${slug} closed · delivered ${pluralize(outcome.delivered, "note")}${released}`,
    );
  }
  const pending = [
    pluralize(outcome.candidates, "note"),
    pluralize(outcome.questions, "question"),
  ].join(" and ");
  const wedged =
    outcome.wedged === 0
      ? ""
      : ` · ${outcome.wedged} live ${outcome.wedged === 1 ? "session" : "sessions"} didn't flush`;
  return noted(
    `arc ${slug} is waiting at the airlock · ${pending} to triage in the memory pane${wedged} · /arc-abandon ${slug} archives without distilling`,
  );
}

export function describeFinishOutcome(slug: string, outcome: AirlockFinishOutcome): string {
  switch (outcome.kind) {
    case "closed":
    case "pending":
      return describeCloseOutcome(slug, outcome);
    case "undecided":
      return `arc ${slug} still has ${pluralize(outcome.items.length, "item")} to decide · a d c on each row`;
    case "wedged":
      return `${pluralize(outcome.sessions.length, "session")} didn't flush · f forces the close past them`;
  }
}

function byCreation(left: ArcSummary, right: ArcSummary): number {
  return left.created.localeCompare(right.created) || left.slug.localeCompare(right.slug);
}
