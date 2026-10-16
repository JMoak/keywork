import {
  agesOf,
  builtinDecider,
  type Decided,
  type DecisionChoice,
  type DecisionSubject,
  deciderEdition,
  type MemoryDecider,
  type MemoryDecision,
  type MemoryQuestion,
  memoryQuestions,
  type Note,
  type SearchHit,
} from "../../packages/engine/src/index.ts";
import {
  type ActionPoint,
  type AnswerLine,
  type CandidateNote,
  type DecisionPoint,
  type DriftPoint,
  type EntryPoint,
  type MentionPoint,
  type NoteState,
  type OutcomeRecord,
  type PairPoint,
  pointHash,
} from "./corpus.ts";

export interface DeciderEdition {
  decider: string;
  version: string;
}

export interface DeciderArm {
  edition: DeciderEdition;
  answer(point: DecisionPoint): Promise<AnswerLine>;
}

export const builtinEdition: DeciderEdition = { decider: "builtin", version: "1" };
export const offEdition: DeciderEdition = { decider: "off", version: "1" };

export function editionName(edition: DeciderEdition): string {
  return deciderEdition(edition.decider, edition.version);
}

export function builtinArm(): DeciderArm {
  return portArm(builtinEdition, builtinDecider());
}

export function offArm(): DeciderArm {
  return portArm(offEdition, memoryOffDecider());
}

export function portArm(edition: DeciderEdition, decider: MemoryDecider): DeciderArm {
  return {
    edition,
    answer: async (point) => {
      const { outcome, decision } = await askPort(decider, point);
      return {
        point: point.id,
        pointHash: pointHash(point),
        question: point.question,
        outcome,
        decision,
      };
    },
  };
}

export async function runArm(
  arm: DeciderArm,
  points: readonly DecisionPoint[],
): Promise<AnswerLine[]> {
  const answers: AnswerLine[] = [];
  for (const point of points) answers.push(await arm.answer(point));
  return answers;
}

export function memoryOffDecider(): MemoryDecider {
  return {
    id: "off",
    chooseForAction: async (input) =>
      offDecided(
        memoryQuestions.actionRelevance,
        { kind: "call", callId: input.action.callId },
        input.hits.map((hit) => hit.note.name),
        [],
        { kept: [], dropped: input.hits.map((hit) => hit.note.name) },
      ),
    triageEntries: async (input) =>
      input.entries.map((entry) =>
        offDecided(
          memoryQuestions.entryDurability,
          { kind: "entry", entryId: entry.id },
          [entry.id],
          { entryId: entry.id, durability: "unsure" as const },
          "unsure",
        ),
      ),
    relatePair: async (pair) =>
      offDecided(
        memoryQuestions.pairRelation,
        { kind: "pair", older: agesOf(pair).older.name, newer: agesOf(pair).newer.name },
        [pair.a.name, pair.b.name],
        { relation: "unsure" as const, confidence: 0 },
        "unsure",
      ),
    assessDrift: async (input) =>
      offDecided(
        memoryQuestions.driftVerdict,
        { kind: "note", note: input.note.name },
        [input.note.name],
        { verdict: "unsure" as const, reason: memoryOffRule },
        "unsure",
      ),
    weighMention: async (candidate) =>
      offDecided(
        memoryQuestions.mentionIsLink,
        { kind: "mention", note: candidate.source.name, target: candidate.target.name },
        [candidate.target.name],
        "no-link" as const,
        "no-link",
      ),
  };
}

export function noteOf(
  state: Pick<NoteState, "name" | "title" | "body"> & Partial<NoteState>,
): Note {
  return {
    name: state.name,
    path: `${state.name}.md`,
    title: state.title,
    provenance: state.provenance ?? "agent",
    pinned: false,
    aliases: [],
    body: state.body,
    links: [],
    tokens: Math.ceil(state.body.length / 4),
    frontmatter: {},
    ...(state.created !== undefined && { created: state.created }),
  };
}

export function hitOf(candidate: CandidateNote): SearchHit {
  return {
    note: { ...noteOf({ ...candidate, body: candidate.excerpt }), tokens: candidate.tokens },
    score: 0,
    legs: legsOf(candidate),
    ranks: candidate.ranks,
    superseded: candidate.superseded,
    relations: { contradicts: [] },
  };
}

async function askPort(
  decider: MemoryDecider,
  point: DecisionPoint,
): Promise<{ outcome: OutcomeRecord; decision: MemoryDecision }> {
  switch (point.question) {
    case memoryQuestions.actionRelevance:
      return chooseForAction(decider, point);
    case memoryQuestions.entryDurability:
      return triageEntry(decider, point);
    case memoryQuestions.pairRelation:
      return relatePair(decider, point);
    case memoryQuestions.driftVerdict:
      return assessDrift(decider, point);
    case memoryQuestions.mentionIsLink:
      return weighMention(decider, point);
  }
}

async function chooseForAction(decider: MemoryDecider, point: ActionPoint) {
  const { outcome, decision } = await decider.chooseForAction({
    action: point.action,
    hits: point.candidates.map(hitOf),
    surfaced: new Set(point.surfaced),
    budget: point.budget,
  });
  return { outcome: { kept: outcome.map((hit) => hit.note.name) }, decision };
}

async function triageEntry(decider: MemoryDecider, point: EntryPoint) {
  const [triaged] = await decider.triageEntries({ entries: [point.entry] });
  if (triaged === undefined)
    throw new Error(`${decider.id} left entry ${point.entry.id} untriaged`);
  return { outcome: { durability: triaged.outcome.durability }, decision: triaged.decision };
}

async function relatePair(decider: MemoryDecider, point: PairPoint) {
  const { outcome, decision } = await decider.relatePair({
    a: noteOf(point.a),
    b: noteOf(point.b),
    similarity: point.similarity,
  });
  const keep = outcome.relation === "duplicate" ? outcome.keep : undefined;
  return {
    outcome: {
      relation: outcome.relation,
      confidence: outcome.confidence,
      ...(keep !== undefined && { keep }),
    },
    decision,
  };
}

async function assessDrift(decider: MemoryDecider, point: DriftPoint) {
  const { outcome, decision } = await decider.assessDrift({
    note: noteOf(point.note),
    evidence: point.evidence,
  });
  return { outcome: { verdict: outcome.verdict, reason: outcome.reason }, decision };
}

async function weighMention(decider: MemoryDecider, point: MentionPoint) {
  const { outcome, decision } = await decider.weighMention({
    source: noteOf({ ...point.source, body: point.source.sentence }),
    target: noteOf({ ...point.target, body: point.target.excerpt }),
    mention: point.mention,
  });
  return { outcome: { verdict: outcome }, decision };
}

function offDecided<Outcome>(
  question: MemoryQuestion,
  about: DecisionSubject,
  candidates: string[],
  outcome: Outcome,
  choice: DecisionChoice,
): Decided<Outcome> {
  return {
    outcome,
    decision: {
      id: `off:${question}:${candidates.join("|")}`,
      question,
      about,
      candidates,
      choice,
      decider: "builtin",
      rule: memoryOffRule,
      latencyMs: 0,
    },
  };
}

const memoryOffRule = "memory off: the floor every decider is measured above";

function legsOf(candidate: CandidateNote): SearchHit["legs"] {
  return (["lexical", "semantic", "graph"] as const).filter(
    (leg) => candidate.ranks[leg] !== undefined,
  );
}
