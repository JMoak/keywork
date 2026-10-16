import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agesOf,
  auditFile,
  builtinDecider,
  type CurationJudgmentPort,
  type DailyEntryCandidate,
  Gardener,
  isMissingFileError,
  type MemoryDecider,
  MemoryStore,
  type MentionCandidate,
  memoryQuestions,
  type Note,
  type NotePair,
  parseAuditLog,
  titleKey,
} from "../../packages/engine/src/index.ts";
import {
  type AnswerLabel,
  type DriftPoint,
  type EntryPoint,
  halfOf,
  type MentionPoint,
  type NoteState,
  type PairPoint,
} from "./corpus.ts";
import {
  curationBody,
  driftEvidence,
  mentionSentence,
  type Redact,
  recallExcerpt,
} from "./exposure.ts";

export type CurationPoint = EntryPoint | PairPoint | DriftPoint | MentionPoint;

export interface CurationHarvest {
  points: CurationPoint[];
  labels: AnswerLabel[];
}

export async function harvestCuration(vault: string, redact: Redact): Promise<CurationHarvest> {
  const scratch = await mkdtemp(join(tmpdir(), "keywork-memory-eval-"));
  try {
    await cp(vault, scratch, { recursive: true });
    const store = new MemoryStore({ vaultRoot: scratch, trusted: true });
    const notes = await store.listNotes();
    const weighed = await weighLikeTheGardener(store);
    const verdicts = parseVerdicts(await readAudit(vault));
    const points = [
      ...weighed.entries.map((entry) => entryPoint(entry, redact)),
      ...pairPoints(weighed.pairs, verdicts, notes, redact),
      ...(await driftPoints(store, notes, redact)),
      ...weighed.mentions.map((mention) => mentionPoint(mention, redact)),
    ];
    return { points, labels: inboxLabels(points, verdicts) };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

interface Weighed {
  entries: DailyEntryCandidate[];
  pairs: NotePair[];
  mentions: MentionCandidate[];
}

async function weighLikeTheGardener(store: MemoryStore): Promise<Weighed> {
  const weighed: Weighed = { entries: [], pairs: [], mentions: [] };
  await new Gardener({
    store,
    inbox: { propose: async () => [] },
    judgment: silentChatModel,
    decider: listeningDecider(weighed),
    proposeOnly: true,
  }).sweep();
  return weighed;
}

const silentChatModel: CurationJudgmentPort = {
  id: "memory-eval-harvest",
  proposePromotions: async () => [],
  classifyPair: async () => ({ relation: "distinct", confidence: 0 }),
};

function listeningDecider(weighed: Weighed): MemoryDecider {
  const builtin = builtinDecider();
  return {
    ...builtin,
    triageEntries: (input) => {
      weighed.entries.push(...input.entries);
      return builtin.triageEntries(input);
    },
    relatePair: (pair) => {
      weighed.pairs.push(pair);
      return builtin.relatePair(pair);
    },
    weighMention: (candidate) => {
      weighed.mentions.push(candidate);
      return builtin.weighMention(candidate);
    },
  };
}

function entryPoint(entry: DailyEntryCandidate, redact: Redact): EntryPoint {
  const id = `entry:${entry.id}`;
  return {
    id,
    question: memoryQuestions.entryDurability,
    half: halfOf(id),
    entry: { ...entry, text: redact(entry.text) },
  };
}

function pairPoints(
  weighed: readonly NotePair[],
  verdicts: readonly InboxVerdict[],
  notes: readonly Note[],
  redact: Redact,
): PairPoint[] {
  const byKey = new Map(notes.map((note) => [titleKey(note.name), note]));
  const reviewed = verdicts.flatMap((verdict) => {
    const [a, b] = verdict.notes.map((key) => byKey.get(key));
    return verdict.question === memoryQuestions.pairRelation && a !== undefined && b !== undefined
      ? [{ a, b, similarity: wordJaccard(a.body, b.body) }]
      : [];
  });
  const points = new Map<string, PairPoint>();
  for (const pair of [...weighed, ...reviewed]) {
    const point = pairPoint(pair, redact);
    if (!points.has(point.id)) points.set(point.id, point);
  }
  return [...points.values()];
}

function pairPoint(pair: NotePair, redact: Redact): PairPoint {
  const { older, newer } = agesOf(pair);
  const id = `pair:${older.name}|${newer.name}`;
  return {
    id,
    question: memoryQuestions.pairRelation,
    half: halfOf(id),
    a: noteState(older, redact),
    b: noteState(newer, redact),
    similarity: Math.round(pair.similarity * 1000) / 1000,
  };
}

async function driftPoints(
  store: MemoryStore,
  notes: readonly Note[],
  redact: Redact,
): Promise<DriftPoint[]> {
  const byKey = new Map(notes.map((note) => [titleKey(note.name), note]));
  return (await store.listStaged()).flatMap((item) => {
    if (item.kind !== "drift-review") return [];
    const note = byKey.get(titleKey(item.note));
    if (note === undefined) return [];
    const id = `drift:${note.name}`;
    return [
      {
        id,
        question: memoryQuestions.driftVerdict,
        half: halfOf(id),
        note: noteState(note, redact),
        evidence: driftEvidence(item.evidence, redact),
      },
    ];
  });
}

function mentionPoint(candidate: MentionCandidate, redact: Redact): MentionPoint {
  const { source, target, mention } = candidate;
  const id = `mention:${source.name}->${target.name}`;
  return {
    id,
    question: memoryQuestions.mentionIsLink,
    half: halfOf(id),
    source: {
      name: source.name,
      title: redact(source.title),
      sentence: mentionSentence(source.body, mention, redact),
    },
    target: {
      name: target.name,
      title: redact(target.title),
      excerpt: recallExcerpt(target.body, redact),
    },
    mention,
  };
}

function noteState(note: Note, redact: Redact): NoteState {
  return {
    name: note.name,
    title: redact(note.title),
    provenance: note.provenance,
    ...(note.created !== undefined && { created: note.created }),
    body: curationBody(note.body, redact),
  };
}

interface InboxVerdict {
  question: CurationPoint["question"];
  notes: string[];
  answer: (point: CurationPoint) => string;
  approved: boolean;
  line: string;
}

function parseVerdicts(audit: string): InboxVerdict[] {
  return parseAuditLog(audit).flatMap(({ timestamp, event }) => {
    const match = /^(approved|discarded) ([a-z-]+):(.+)$/.exec(event);
    if (match === null) return [];
    const [, verb, kind, subject] = match;
    const verdict = verdictOf(kind ?? "", subject ?? "");
    return verdict === undefined
      ? []
      : [
          {
            ...verdict,
            approved: verb === "approved",
            line: `${verb} ${kind}:${subject} at ${timestamp}`,
          },
        ];
  });
}

function verdictOf(
  kind: string,
  subject: string,
): Pick<InboxVerdict, "question" | "notes" | "answer"> | undefined {
  const pair = subject.split("<->");
  const arrow = subject.split("->");
  switch (kind) {
    case "merge":
      return { question: memoryQuestions.pairRelation, notes: pair, answer: () => "duplicate" };
    case "contradiction":
      return { question: memoryQuestions.pairRelation, notes: pair, answer: () => "contradiction" };
    case "supersession":
      return {
        question: memoryQuestions.pairRelation,
        notes: arrow,
        answer: (point) => supersessionAnswer(point, arrow[1] ?? ""),
      };
    case "link":
      return { question: memoryQuestions.mentionIsLink, notes: arrow, answer: () => "link" };
    case "drift":
      return { question: memoryQuestions.driftVerdict, notes: [subject], answer: () => "stale" };
    default:
      return undefined;
  }
}

function supersessionAnswer(point: CurationPoint, winner: string): string {
  if (point.question !== memoryQuestions.pairRelation) return "unsure";
  return titleKey(point.b.name) === winner ? "newer-supersedes-older" : "older-still-holds";
}

function inboxLabels(
  points: readonly CurationPoint[],
  verdicts: readonly InboxVerdict[],
): AnswerLabel[] {
  return verdicts.flatMap((verdict) => {
    const point = points.find(
      (candidate) =>
        candidate.question === verdict.question && sameKeys(subjectKeys(candidate), verdict.notes),
    );
    if (point === undefined) return [];
    return [
      {
        point: point.id,
        answer: verdict.answer(point),
        holds: verdict.approved,
        source: "inbox" as const,
        evidence: verdict.line,
      },
    ];
  });
}

function subjectKeys(point: CurationPoint): string[] {
  switch (point.question) {
    case memoryQuestions.entryDurability:
      return [point.entry.id];
    case memoryQuestions.pairRelation:
      return [titleKey(point.a.name), titleKey(point.b.name)];
    case memoryQuestions.driftVerdict:
      return [titleKey(point.note.name)];
    case memoryQuestions.mentionIsLink:
      return [titleKey(point.source.name), titleKey(point.target.name)];
  }
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join("\n") === [...right].sort().join("\n");
}

async function readAudit(vault: string): Promise<string> {
  try {
    return await readFile(join(vault, auditFile), "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return "";
    throw error;
  }
}

function wordJaccard(left: string, right: string): number {
  const a = words(left);
  const b = words(right);
  const shared = [...a].filter((word) => b.has(word)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : shared / union;
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}
