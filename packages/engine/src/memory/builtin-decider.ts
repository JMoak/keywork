import {
  type ActionCandidates,
  actionAsk,
  actionBudgetFit,
  agesOf,
  type Decided,
  type DecisionAsk,
  type DecisionChoice,
  type DriftCase,
  driftAsk,
  type EntryTriage,
  entryAsk,
  type MemoryDecider,
  type MentionCandidate,
  mentionAsk,
  type NotePair,
  type PairJudgment,
  type PairSide,
  type PendingAction,
  pairAsk,
  screenForAction,
} from "./decider.ts";
import type { DriftAssessment, DriftJudgmentPort } from "./drift.ts";
import type { CurationJudgmentPort, DailyEntryCandidate, PairVerdict } from "./gardener.ts";
import type { Note } from "./notes.ts";
import { type SearchHit, tokenize } from "./search.ts";

export interface BuiltinSeams {
  curation?: CurationJudgmentPort;
  drift?: DriftJudgmentPort;
}

export const builtinDeciderId = "builtin";

export function builtinDecider(seams: BuiltinSeams = {}): MemoryDecider {
  return {
    id: builtinDeciderId,
    chooseForAction: (input) => judged(actionAsk(input), () => chooseByRule(input)),
    triageEntries: (input) =>
      Promise.all(
        input.entries.map((entry) => judged(entryAsk(entry), () => sendToDistiller(entry))),
      ),
    relatePair: (pair) => judged(pairAsk(pair), () => relateByChatModel(pair, seams.curation)),
    assessDrift: (input) => judged(driftAsk(input), () => assessByChatModel(input, seams.drift)),
    weighMention: (candidate) => judged(mentionAsk(candidate), () => linkEveryMention(candidate)),
  };
}

export interface RuleRelevance {
  relevant: boolean;
  why: string;
}

export function relevanceByRule(hit: SearchHit, action: PendingAction): RuleRelevance {
  if (hit.ranks.lexical === undefined && hit.ranks.semantic === undefined)
    return { relevant: false, why: "is only a graph neighbor" };
  return { relevant: true, why: matchByRule(hit, action) };
}

interface Answer<Outcome> {
  outcome: Outcome;
  choice: DecisionChoice;
  rule: string;
  confidence?: number;
}

async function judged<Outcome>(
  ask: DecisionAsk,
  answer: () => Answer<Outcome> | Promise<Answer<Outcome>>,
): Promise<Decided<Outcome>> {
  const started = performance.now();
  const { outcome, choice, rule, confidence } = await answer();
  return {
    outcome,
    decision: {
      id: crypto.randomUUID(),
      ...ask,
      choice,
      ...(confidence !== undefined && { confidence }),
      decider: "builtin",
      rule,
      latencyMs: Math.round(performance.now() - started),
    },
  };
}

interface HitVerdict {
  hit: SearchHit;
  kept: boolean;
  why: string;
}

function chooseByRule(input: ActionCandidates): Answer<SearchHit[]> {
  const verdicts = verdictsByRule(input);
  const kept = verdicts.filter((verdict) => verdict.kept).map((verdict) => verdict.hit);
  const dropped = verdicts.filter((verdict) => !verdict.kept).map((verdict) => verdict.hit);
  return {
    outcome: kept,
    choice: { kept: namesOf(kept), dropped: namesOf(dropped) },
    rule: verdicts.map(({ hit, why }) => `[[${hit.note.name}]] ${why}`).join("; "),
  };
}

function verdictsByRule({ action, hits, surfaced, budget }: ActionCandidates): HitVerdict[] {
  const fit = actionBudgetFit(budget);
  return hits.map((hit) => {
    const screened = screenForAction(hit, surfaced);
    if (screened !== undefined) return { hit, kept: false, why: screened };
    const relevance = relevanceByRule(hit, action);
    const barred = relevance.relevant ? fit(hit) : relevance.why;
    return barred === undefined
      ? { hit, kept: true, why: relevance.why }
      : { hit, kept: false, why: barred };
  });
}

function matchByRule(hit: SearchHit, action: PendingAction): string {
  if (hit.ranks.lexical === undefined) return `is near the ${action.subjectKind} in meaning`;
  const shared = sharedTerms(action.subject, hit.note);
  if (shared.length === 0) return `matches the ${action.subjectKind} by its words`;
  return `shares ${shared.map((term) => `"${term}"`).join(", ")} with the ${action.subjectKind}`;
}

function sharedTerms(subject: string, note: Note): string[] {
  const noteTerms = new Set(tokenize(`${note.title} ${note.aliases.join(" ")} ${note.body}`));
  return [...new Set(tokenize(subject))].filter((term) => noteTerms.has(term)).slice(0, 3);
}

function namesOf(hits: readonly SearchHit[]): string[] {
  return hits.map((hit) => hit.note.name);
}

function sendToDistiller(entry: DailyEntryCandidate): Answer<EntryTriage> {
  return {
    outcome: { entryId: entry.id, durability: "unsure" },
    choice: "unsure",
    rule: "every trusted entry within the sweep budget goes to the distiller",
  };
}

async function relateByChatModel(
  pair: NotePair,
  chatModel: CurationJudgmentPort | undefined,
): Promise<Answer<PairJudgment>> {
  const similarity = `jaccard ${pair.similarity.toFixed(2)}`;
  if (chatModel === undefined) {
    return {
      outcome: { relation: "unsure", confidence: 0 },
      choice: "unsure",
      rule: `${similarity} · no chat model to judge the pair`,
    };
  }
  const verdict = await chatModel.classifyPair(pair.a, pair.b);
  const judgment = pairJudgmentOf(pair, verdict);
  return {
    outcome: judgment,
    choice: judgment.relation,
    rule: `${similarity} · judged by ${chatModel.id}${keepingClause(judgment)}`,
    confidence: judgment.confidence,
  };
}

function pairJudgmentOf(pair: NotePair, verdict: PairVerdict): PairJudgment {
  const { confidence } = verdict;
  switch (verdict.relation) {
    case "distinct":
    case "contradiction":
      return { relation: verdict.relation, confidence };
    case "duplicate":
      return {
        relation: "duplicate",
        keep: keptSide(pair, verdict.keep),
        confidence,
        ...(verdict.mergedBody !== undefined && { mergedBody: verdict.mergedBody }),
      };
    case "supersedes":
      return {
        relation:
          keptSide(pair, verdict.keep) === "newer" ? "newer-supersedes-older" : "older-still-holds",
        confidence,
      };
  }
}

function keptSide(pair: NotePair, keep: PairVerdict["keep"]): PairSide {
  const { newer } = agesOf(pair);
  const kept = keep === "a" ? pair.a : keep === "b" ? pair.b : newer;
  return kept === newer ? "newer" : "older";
}

function keepingClause(judgment: PairJudgment): string {
  return judgment.relation === "duplicate" ? `, keeping the ${judgment.keep} note` : "";
}

async function assessByChatModel(
  input: DriftCase,
  chatModel: DriftJudgmentPort | undefined,
): Promise<Answer<DriftAssessment>> {
  if (chatModel === undefined)
    return { outcome: unaskedAssessment, choice: "unsure", rule: unaskedAssessment.reason };
  const assessment = await chatModel.assess(input.note, input.evidence);
  const reason = oneLine(assessment.reason).slice(0, reasonCap);
  const asked = `asked ${chatModel.id}`;
  return {
    outcome: assessment,
    choice: assessment.verdict,
    rule: reason === "" ? asked : `${asked} · ${reason}`,
  };
}

const unaskedAssessment: DriftAssessment = { verdict: "unsure", reason: "no chat model to ask" };

const reasonCap = 200;

function linkEveryMention(candidate: MentionCandidate): Answer<"link"> {
  return {
    outcome: "link",
    choice: "link",
    rule: `mentions "${candidate.mention}" without linking it`,
  };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
