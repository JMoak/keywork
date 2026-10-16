import { relevanceByRule } from "./builtin-decider.ts";
import {
  type ActionCandidates,
  actionAsk,
  actionBudgetFit,
  type Decided,
  type DecisionAsk,
  type DecisionChoice,
  type DecisionFallback,
  driftAsk,
  type EntryCandidates,
  type EntryTriage,
  entryAsk,
  type MemoryDecider,
  type MemoryDecision,
  type MemoryQuestion,
  memoryQuestions,
  mentionAsk,
  type PairJudgment,
  pairAsk,
  screenForAction,
} from "./decider.ts";
import type { DailyEntryCandidate } from "./gardener.ts";
import type { JevAnswered, JevClient, JevReply } from "./jev.ts";
import {
  actionRelevancePlan,
  type ChoicePlan,
  driftVerdictPlan,
  entryDurabilityPlan,
  mentionIsLinkPlan,
  noulConfidence,
  type PairReading,
  pairRelationPlan,
  type Reading,
  type RelevancePlan,
  readRecall,
  type Scrub,
  scrubberFor,
} from "./jev-questions.ts";
import { provenQuestions, type QuestionProof } from "./proven-questions.ts";
import type { NamedSecret } from "./redaction.ts";
import type { SearchHit } from "./search.ts";

export interface JevDeciderOptions {
  client: JevClient;
  trial?: boolean;
  secrets?: readonly NamedSecret[];
  proofs?: readonly QuestionProof[];
}

export interface JevDecider {
  readonly client: JevClient;
  readonly scrub: Scrub;
  takes(question: MemoryQuestion): boolean;
}

export const jevDeciderId = "jev";

export function jevDecider(options: JevDeciderOptions): JevDecider {
  const proven = provenQuestions(options.client.model, options.proofs);
  return {
    client: options.client,
    scrub: scrubberFor(options.secrets ?? []),
    takes: (question) => options.trial === true || proven.has(question),
  };
}

export function withFallback(jev: JevDecider, builtin: MemoryDecider): MemoryDecider {
  return {
    id: jevDeciderId,
    chooseForAction: (input) => chooseWithOdds(input, jev, builtin),
    triageEntries: (input) => triageWithJev(input, jev, builtin),
    relatePair: (pair) =>
      decideWithJev(jev, {
        ask: pairAsk(pair),
        plan: () => pairRelationPlan(pair, jev.scrub),
        settle: (reading, odds) => ({
          outcome: pairJudgmentOf(reading, odds),
          choice: reading.relation,
        }),
        byBuiltin: () => builtin.relatePair(pair),
      }),
    assessDrift: (input) =>
      decideWithJev(jev, {
        ask: driftAsk(input),
        plan: () => driftVerdictPlan(input, jev.scrub),
        settle: (verdict, odds) => ({
          outcome: { verdict, reason: `jev: ${verdict} at ${odds.toFixed(2)}` },
          choice: verdict,
        }),
        byBuiltin: () => builtin.assessDrift(input),
      }),
    weighMention: (candidate) =>
      decideWithJev(jev, {
        ask: mentionAsk(candidate),
        plan: () => mentionIsLinkPlan(candidate, jev.scrub),
        settle: (verdict) => ({ outcome: verdict, choice: verdict }),
        byBuiltin: () => builtin.weighMention(candidate),
      }),
  };
}

interface JevRoute<Verdict, Outcome> {
  ask: DecisionAsk;
  plan(): ChoicePlan<Verdict>;
  settle(verdict: Verdict, odds: number): { outcome: Outcome; choice: DecisionChoice };
  byBuiltin(): Promise<Decided<Outcome>>;
}

async function decideWithJev<Verdict, Outcome>(
  jev: JevDecider,
  route: JevRoute<Verdict, Outcome>,
): Promise<Decided<Outcome>> {
  if (!jev.takes(route.ask.question)) return route.byBuiltin();
  const started = performance.now();
  const plan = route.plan();
  const reply = await jev.client.ask(plan.ask);
  if (!reply.ok) return fellBack(await route.byBuiltin(), { reason: reply.reason }, reply, started);
  const reading = plan.read(reply.answers);
  if (reading.verdict === undefined) {
    const fallback = { reason: "undecided" as const, undecided: route.ask.candidates };
    return fellBack(await route.byBuiltin(), fallback, reply, started, reading.scores);
  }
  const { outcome, choice } = route.settle(reading.verdict, reading.odds);
  return { outcome, decision: jevDecision(route.ask, choice, reading, reply, started) };
}

async function triageWithJev(
  input: EntryCandidates,
  jev: JevDecider,
  builtin: MemoryDecider,
): Promise<Decided<EntryTriage>[]> {
  if (!jev.takes(memoryQuestions.entryDurability)) return builtin.triageEntries(input);
  const triaged: Decided<EntryTriage>[] = [];
  for (const entry of input.entries) {
    triaged.push(
      await decideWithJev(jev, {
        ask: entryAsk(entry),
        plan: () => entryDurabilityPlan(entry, input.neighbors?.get(entry.id) ?? [], jev.scrub),
        settle: (durability) => ({
          outcome: { entryId: entry.id, durability },
          choice: durability,
        }),
        byBuiltin: () => triagedByBuiltin(entry, builtin),
      }),
    );
  }
  return triaged;
}

async function triagedByBuiltin(
  entry: DailyEntryCandidate,
  builtin: MemoryDecider,
): Promise<Decided<EntryTriage>> {
  const [triaged] = await builtin.triageEntries({ entries: [entry] });
  if (triaged === undefined)
    throw new Error(`the builtin decider left entry ${entry.id} untriaged`);
  return triaged;
}

async function chooseWithOdds(
  input: ActionCandidates,
  jev: JevDecider,
  builtin: MemoryDecider,
): Promise<Decided<SearchHit[]>> {
  const byRule = builtin.chooseForAction(input);
  const eligible = input.hits.filter((hit) => screenForAction(hit, input.surfaced) === undefined);
  if (!jev.takes(memoryQuestions.actionRelevance) || eligible.length === 0) return byRule;
  const started = performance.now();
  const plan = actionRelevancePlan(input.action, eligible, jev.scrub);
  const reply = await jev.client.ask(plan.ask);
  if (!reply.ok) return fellBack(await byRule, { reason: reply.reason }, reply, started);
  return selectionWithOdds(input, plan, reply, started);
}

type Fate =
  | { hit: SearchHit; reading: "rank-first" | "drop"; odds: number }
  | { hit: SearchHit; reading: "keep" | "skip"; why: string; odds?: number };

function selectionWithOdds(
  input: ActionCandidates,
  plan: RelevancePlan,
  reply: JevAnswered,
  started: number,
): Decided<SearchHit[]> {
  const fates = input.hits.map((hit) => fateOf(hit, input, plan.oddsOf(reply.answers, hit)));
  const ruleWords = new Map<SearchHit, string>(
    fates.flatMap((fate) => ("why" in fate ? [[fate.hit, fate.why] as const] : [])),
  );
  const fit = actionBudgetFit(input.budget);
  const kept: SearchHit[] = [];
  for (const fate of [...fatesReading(fates, "rank-first"), ...fatesReading(fates, "keep")]) {
    const barred = fit(fate.hit);
    if (barred === undefined) kept.push(fate.hit);
    else ruleWords.set(fate.hit, barred);
  }
  const undecided = fates.filter((fate) => "why" in fate && fate.odds !== undefined);
  const decidedByJev = fates.some((fate) => !("why" in fate));
  const rule = input.hits
    .flatMap((hit) => {
      const why = ruleWords.get(hit);
      return why === undefined ? [] : [`[[${hit.note.name}]] ${why}`];
    })
    .join("; ");
  const fallback: DecisionFallback | undefined =
    undecided.length === 0
      ? undefined
      : { reason: "undecided", undecided: undecided.map((fate) => fate.hit.note.name) };
  const confidence = keptConfidence(kept, fates);
  return {
    outcome: kept,
    decision: {
      id: crypto.randomUUID(),
      ...actionAsk(input),
      choice: {
        kept: namesOf(kept),
        dropped: namesOf(input.hits.filter((hit) => !kept.includes(hit))),
      },
      scores: scoresOf(fates, plan),
      ...(confidence !== undefined && { confidence }),
      decider: decidedByJev ? "jev" : "builtin",
      ...(rule !== "" && { rule }),
      ...(fallback !== undefined && { fallback }),
      ...exchangeFacts(reply),
      latencyMs: elapsedSince(started),
    },
  };
}

function fateOf(hit: SearchHit, input: ActionCandidates, odds: number | undefined): Fate {
  const screened = screenForAction(hit, input.surfaced);
  if (screened !== undefined) return { hit, reading: "skip", why: screened };
  const reading = odds === undefined ? "undecided" : readRecall(odds);
  if (odds !== undefined && reading !== "undecided") return { hit, reading, odds };
  const rule = relevanceByRule(hit, input.action);
  return {
    hit,
    reading: rule.relevant ? "keep" : "skip",
    why: rule.why,
    ...(odds !== undefined && { odds }),
  };
}

function fatesReading(fates: readonly Fate[], reading: Fate["reading"]): Fate[] {
  return fates.filter((fate) => fate.reading === reading);
}

function scoresOf(fates: readonly Fate[], plan: RelevancePlan): Record<string, number> {
  return Object.fromEntries(
    fates.flatMap((fate) => {
      const key = plan.keyOf(fate.hit);
      return key === undefined || fate.odds === undefined ? [] : [[key, fate.odds] as const];
    }),
  );
}

function keptConfidence(kept: readonly SearchHit[], fates: readonly Fate[]): number | undefined {
  const odds = fates
    .filter((fate) => kept.includes(fate.hit) && fate.odds !== undefined)
    .map((fate) => noulConfidence(fate.odds ?? 0));
  return odds.length === 0 ? undefined : Math.min(...odds);
}

function jevDecision<Verdict>(
  ask: DecisionAsk,
  choice: DecisionChoice,
  reading: Reading<Verdict>,
  reply: JevAnswered,
  started: number,
): MemoryDecision {
  return {
    id: crypto.randomUUID(),
    ...ask,
    choice,
    scores: reading.scores,
    confidence: reading.confidence,
    decider: "jev",
    ...exchangeFacts(reply),
    latencyMs: elapsedSince(started),
  };
}

function fellBack<Outcome>(
  decided: Decided<Outcome>,
  fallback: DecisionFallback,
  reply: JevReply,
  started: number,
  scores?: Record<string, number>,
): Decided<Outcome> {
  return {
    outcome: decided.outcome,
    decision: {
      ...decided.decision,
      ...(scores !== undefined && Object.keys(scores).length > 0 && { scores }),
      fallback,
      ...exchangeFacts(reply),
      latencyMs: elapsedSince(started),
    },
  };
}

function exchangeFacts(
  reply: JevReply,
): Partial<Pick<MemoryDecision, "model" | "inputTokens" | "stateHash">> {
  return {
    ...(reply.model !== undefined && { model: reply.model }),
    ...(reply.inputTokens !== undefined && { inputTokens: reply.inputTokens }),
    ...(reply.stateHash !== undefined && { stateHash: reply.stateHash }),
  };
}

function pairJudgmentOf(reading: PairReading, odds: number): PairJudgment {
  const { relation, band } = reading;
  return relation === "duplicate"
    ? { relation, keep: "newer", confidence: odds, band }
    : { relation, confidence: odds, band };
}

function namesOf(hits: readonly SearchHit[]): string[] {
  return hits.map((hit) => hit.note.name);
}

function elapsedSince(started: number): number {
  return Math.round(performance.now() - started);
}
