import { type MemoryDecision, memoryQuestions, type Selection } from "@keywork/engine";
import type { MemoryRow, RowSpan } from "./memory-rows.ts";
import { pluralize } from "./pluralize.ts";

export interface DecisionsView {
  readonly session: string;
  readonly decisions: readonly MemoryDecision[];
  actionOf(callId: string): string | undefined;
}

export const noDecisionsLine =
  "no decisions yet · memory decides what to recall before each write, edit or command";

export const noSessionLine = "no conversation here · the lens follows the focused session";

export const decisionsHint = "enter shows the candidates · tab or esc returns to the garden";

export function decisionRows(
  view: DecisionsView | undefined,
  unfolded: (id: string) => boolean,
): MemoryRow[] {
  if (view === undefined) return [emptyRow("decisions-none", noSessionLine)];
  const newestFirst = [...view.decisions].reverse();
  const head = headerRow(
    `decisions · ${view.session} · ${pluralize(newestFirst.length, "decision")}`,
  );
  if (newestFirst.length === 0) return [head, emptyRow("decisions-empty", noDecisionsLine)];
  return [
    head,
    ...newestFirst.flatMap((decision) => [
      decisionRow(decision, view),
      ...(unfolded(decision.id) ? foldRows(decision) : []),
    ]),
    emptyRow("decisions-hint", decisionsHint),
  ];
}

export function decisionOdds(decision: MemoryDecision): number | undefined {
  if (decision.confidence !== undefined) return decision.confidence;
  const chosen = isSelection(decision.choice) ? decision.choice.kept : [decision.choice];
  const odds = chosen.flatMap((name) => {
    const score = decision.scores?.[name];
    return score === undefined ? [] : [score];
  });
  return odds.length === 0 ? undefined : Math.min(...odds);
}

export function decisionMark(decision: MemoryDecision): string {
  if (decision.choice === "unsure") return densityRamp[0];
  const odds = decisionOdds(decision);
  if (odds === undefined) return densityRamp[2];
  const step = Math.floor(Math.min(1, Math.max(0, odds)) * densityRamp.length);
  return densityRamp[Math.min(step, densityRamp.length - 1)] ?? densityRamp[0];
}

const densityRamp = ["░", "▒", "▓", "█"] as const;
const foldIndent = "     ";

function decisionRow(decision: MemoryDecision, view: DecisionsView): MemoryRow {
  const asked = askedWords(decision, view);
  const facts = decisionFacts(decision).join(" · ");
  const spans: RowSpan[] = [
    { text: `${decisionMark(decision)} `, ink: "mid" },
    { text: asked, ink: "text" },
    { text: ` · ${facts}`, ink: "dim" },
  ];
  return {
    id: `decision:${decision.id}`,
    kind: "decision",
    text: spans.map((span) => span.text).join(""),
    tone: "normal",
    selectable: true,
    spans,
  };
}

function foldRows(decision: MemoryDecision): MemoryRow[] {
  const kept = isSelection(decision.choice) ? decision.choice.kept : undefined;
  const named = decision.about.kind === "entry" ? (id: string) => id : noteLink;
  const candidates = decision.candidates.map((candidate) => {
    const verdict = kept === undefined ? "offered" : kept.includes(candidate) ? "kept" : "dropped";
    const score = decision.scores?.[candidate];
    const odds = score === undefined ? "" : ` · ${oddsText(score)}`;
    return foldRow(`${decision.id}:${candidate}`, `${verdict} ${named(candidate)}${odds}`);
  });
  const rule = decision.rule === undefined ? [] : [foldRow(`${decision.id}:rule`, decision.rule)];
  const undecided = decision.fallback?.undecided ?? [];
  const left =
    undecided.length === 0
      ? []
      : [foldRow(`${decision.id}:undecided`, `left to the rule · ${undecided.join(", ")}`)];
  return [...candidates, ...rule, ...left];
}

function askedWords(decision: MemoryDecision, view: DecisionsView): string {
  const { about } = decision;
  switch (about.kind) {
    case "call":
      return `recall before ${view.actionOf(about.callId) ?? `call ${about.callId}`}`;
    case "entry":
      return decision.question === memoryQuestions.entryKind
        ? `kind of entry ${about.entryId}`
        : `triage entry ${about.entryId}`;
    case "pair":
      return `relate ${noteLink(about.older)} and ${noteLink(about.newer)}`;
    case "note":
      return `does ${noteLink(about.note)} still hold`;
    case "mention":
      return `link ${noteLink(about.note)} to ${noteLink(about.target)}`;
    case "query":
      return `weigh hits for "${about.query}"`;
  }
}

function decisionFacts(decision: MemoryDecision): string[] {
  return [
    choiceWords(decision),
    deciderOdds(decision),
    ...(decision.fallback === undefined ? [] : [`fallback ${decision.fallback.reason}`]),
    elapsedText(decision.latencyMs),
  ];
}

function choiceWords(decision: MemoryDecision): string {
  const { choice } = decision;
  return isSelection(choice)
    ? `kept ${choice.kept.length} of ${decision.candidates.length}`
    : choice.replaceAll("-", " ");
}

function deciderOdds(decision: MemoryDecision): string {
  const odds = decisionOdds(decision);
  return odds === undefined ? decision.decider : `${decision.decider} ${oddsText(odds)}`;
}

function isSelection(choice: MemoryDecision["choice"]): choice is Selection {
  return typeof choice === "object";
}

function oddsText(probability: number): string {
  return probability.toFixed(2);
}

function noteLink(name: string): string {
  return `[[${name}]]`;
}

function elapsedText(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function headerRow(text: string): MemoryRow {
  return { id: "decisions-header", kind: "header", text, tone: "heading", selectable: false };
}

function foldRow(id: string, text: string): MemoryRow {
  return {
    id: `fold:${id}`,
    kind: "why",
    text: `${foldIndent}${text}`,
    tone: "dim",
    selectable: false,
  };
}

function emptyRow(id: string, text: string): MemoryRow {
  return { id, kind: "empty", text, tone: "dim", selectable: false };
}
