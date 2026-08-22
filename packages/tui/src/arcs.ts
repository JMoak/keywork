import { type ArcRecord, type ArcStatus, kebabTitle, validateArcSlug } from "@keywork/engine";
import { arcAnchor } from "./chroma.ts";
import { pluralize } from "./pluralize.ts";
import type { Theme } from "./theme.ts";

export type { ArcStatus };

export type ArcSummary = Pick<ArcRecord, "slug" | "status" | "created"> & { sessions: number };

export type ArcCloseOutcome =
  | { kind: "closed"; delivered: number; released: number }
  | { kind: "pending"; candidates: number; questions: number; wedged: number };

export interface ArcsPort {
  list(): Promise<ArcSummary[]>;
  create(slug: string): Promise<ArcSummary>;
  close(slug: string): Promise<ArcCloseOutcome>;
  abandon(slug: string): Promise<void>;
  subscribe?(listener: () => void): () => void;
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
    return (cause as Error).message;
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
  if (outcome.kind === "closed") {
    const released =
      outcome.released === 0 ? "" : ` · ${pluralize(outcome.released, "session")} released`;
    return `arc ${slug} closed · delivered ${pluralize(outcome.delivered, "note")}${released}`;
  }
  const pending = [
    pluralize(outcome.candidates, "note"),
    pluralize(outcome.questions, "question"),
  ].join(" and ");
  const wedged =
    outcome.wedged === 0
      ? ""
      : ` · ${outcome.wedged} live ${outcome.wedged === 1 ? "session" : "sessions"} didn't flush`;
  return `arc ${slug} is waiting at the airlock · ${pending} to triage in the memory pane${wedged} · /arc abandon ${slug} archives without distilling`;
}

function byCreation(left: ArcSummary, right: ArcSummary): number {
  return left.created.localeCompare(right.created) || left.slug.localeCompare(right.slug);
}
