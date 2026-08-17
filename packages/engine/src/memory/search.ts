import { MemoryGraph } from "./graph.ts";
import { titleKey } from "./naming.ts";
import type { MemoryStore, Note } from "./store.ts";

export interface EmbeddingsPort {
  readonly id: string;
  embed(texts: string[]): Promise<number[][]>;
}

export type SearchLeg = "lexical" | "semantic" | "graph";

export interface NoteRelations {
  supersedes?: string;
  supersededBy?: string;
  contradicts: string[];
}

export interface SearchHit {
  note: Note;
  score: number;
  legs: SearchLeg[];
  superseded: boolean;
  relations: NoteRelations;
}

export type RetrievalSource =
  | { kind: "lexical" }
  | { kind: "hybrid"; embeddings: string }
  | { kind: "lexical-degraded"; embeddings: string; reason: string };

export interface SearchOutcome {
  hits: SearchHit[];
  source: RetrievalSource;
}

export interface SearchOptions {
  limit?: number;
}

export type SearchObserver = (outcome: SearchOutcome) => void;

const defaultLimit = 8;
const legDepth = 50;
const rrfK = 60;
const titleWeight = 3;
const aliasWeight = 3;
const embeddingTextCap = 2000;

export class MemorySearch {
  private readonly vectors = new Map<string, { hash: string; vector: number[] }>();

  constructor(
    private readonly store: MemoryStore,
    private readonly embeddings?: EmbeddingsPort,
    private readonly observer?: SearchObserver,
  ) {}

  source(): RetrievalSource {
    return this.embeddings === undefined
      ? { kind: "lexical" }
      : { kind: "hybrid", embeddings: this.embeddings.id };
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchOutcome> {
    const outcome = await this.runSearch(query, options);
    this.observer?.(outcome);
    return outcome;
  }

  private async runSearch(query: string, options: SearchOptions): Promise<SearchOutcome> {
    const limit = options.limit ?? defaultLimit;
    const notes = await this.store.listNotes();
    if (notes.length === 0 || query.trim() === "") return { hits: [], source: this.source() };
    const graph = MemoryGraph.fromNotes(notes);
    const lexical = lexicalRanking(notes, query);
    const { semantic, source } = await this.semanticRanking(notes, query);
    const fused = fuseRankings([lexical, semantic, graphRanking(graph, notes, query)]);
    const hits = applySupersededFloor(fused)
      .slice(0, limit)
      .map((hit) => withRelations(hit, graph));
    return { hits, source };
  }

  private async semanticRanking(
    notes: Note[],
    query: string,
  ): Promise<{ semantic: RankedNote[]; source: RetrievalSource }> {
    if (this.embeddings === undefined) return { semantic: [], source: { kind: "lexical" } };
    try {
      const noteVectors = await this.noteVectors(notes);
      const [queryVector] = await this.embeddings.embed([query]);
      if (queryVector === undefined) throw new Error("empty embedding response");
      const unit = normalize(queryVector);
      const scored = notes
        .map((note) => ({ note, score: dot(unit, noteVectors.get(note.path) ?? []) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, legDepth);
      return { semantic: scored, source: { kind: "hybrid", embeddings: this.embeddings.id } };
    } catch (error) {
      return {
        semantic: [],
        source: {
          kind: "lexical-degraded",
          embeddings: this.embeddings.id,
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async noteVectors(notes: Note[]): Promise<Map<string, number[]>> {
    const port = this.embeddings;
    if (port === undefined) return new Map();
    const stale = notes.filter((note) => {
      const cached = this.vectors.get(note.path);
      return cached === undefined || cached.hash !== embeddingText(note);
    });
    if (stale.length > 0) {
      const embedded = await port.embed(stale.map(embeddingText));
      stale.forEach((note, index) => {
        const vector = embedded[index];
        if (vector === undefined) throw new Error("embedding response shorter than request");
        this.vectors.set(note.path, { hash: embeddingText(note), vector: normalize(vector) });
      });
    }
    const result = new Map<string, number[]>();
    for (const note of notes) {
      const cached = this.vectors.get(note.path);
      if (cached !== undefined) result.set(note.path, cached.vector);
    }
    return result;
  }
}

interface RankedNote {
  note: Note;
  score: number;
}

export function lexicalRanking(notes: Note[], query: string): RankedNote[] {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0) return [];
  const docs = notes.map((note) => ({ note, terms: documentTerms(note) }));
  const averageLength = docs.reduce((sum, doc) => sum + doc.terms.length, 0) / docs.length || 1;
  const documentFrequency = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc.terms)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  return docs
    .map((doc) => ({
      note: doc.note,
      score: bm25(doc.terms, queryTerms, documentFrequency, docs.length, averageLength),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, legDepth);
}

function graphRanking(graph: MemoryGraph, notes: Note[], query: string): RankedNote[] {
  const seeds = seedEntities(notes, query);
  if (seeds.length === 0) return [];
  const byKey = new Map(notes.map((note) => [titleKey(note.name), note]));
  return graph
    .rank(seeds.map((seed) => seed.name))
    .flatMap(({ name, score }) => {
      const note = byKey.get(titleKey(name));
      return note === undefined ? [] : [{ note, score }];
    })
    .slice(0, legDepth);
}

function seedEntities(notes: Note[], query: string): Note[] {
  const queryTerms = new Set(tokenize(query));
  if (queryTerms.size === 0) return [];
  return notes.filter((note) =>
    [note.title, ...note.aliases].some((name) => isSeedName(name, queryTerms)),
  );
}

function isSeedName(name: string, queryTerms: Set<string>): boolean {
  const terms = tokenize(name);
  return terms.length > 0 && terms.every((term) => queryTerms.has(term));
}

type FusedHit = Omit<SearchHit, "relations">;

function fuseRankings(rankings: RankedNote[][]): FusedHit[] {
  const legNames: SearchLeg[] = ["lexical", "semantic", "graph"];
  const byPath = new Map<string, FusedHit>();
  rankings.forEach((ranking, legIndex) => {
    ranking.forEach((entry, rank) => {
      const hit = byPath.get(entry.note.path) ?? {
        note: entry.note,
        score: 0,
        legs: [],
        superseded: entry.note.supersededBy !== undefined,
      };
      hit.score += 1 / (rrfK + rank + 1);
      const leg = legNames[legIndex];
      if (leg !== undefined && !hit.legs.includes(leg)) hit.legs.push(leg);
      byPath.set(entry.note.path, hit);
    });
  });
  return [...byPath.values()].sort((a, b) => b.score - a.score);
}

function withRelations(hit: FusedHit, graph: MemoryGraph): SearchHit {
  return {
    ...hit,
    relations: {
      ...(hit.note.supersedes !== undefined && { supersedes: hit.note.supersedes }),
      ...(hit.note.supersededBy !== undefined && { supersededBy: hit.note.supersededBy }),
      contradicts: graph.contradictionsOf(hit.note.name),
    },
  };
}

function applySupersededFloor(hits: FusedHit[]): FusedHit[] {
  return [...hits.filter((hit) => !hit.superseded), ...hits.filter((hit) => hit.superseded)];
}

function bm25(
  terms: string[],
  queryTerms: string[],
  documentFrequency: Map<string, number>,
  documentCount: number,
  averageLength: number,
): number {
  const k1 = 1.2;
  const b = 0.75;
  const counts = new Map<string, number>();
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  let score = 0;
  for (const term of queryTerms) {
    const frequency = counts.get(term) ?? 0;
    if (frequency === 0) continue;
    const df = documentFrequency.get(term) ?? 0;
    const idf = Math.log(1 + (documentCount - df + 0.5) / (df + 0.5));
    const lengthNorm = 1 - b + b * (terms.length / averageLength);
    score += idf * ((frequency * (k1 + 1)) / (frequency + k1 * lengthNorm));
  }
  return score;
}

function documentTerms(note: Note): string[] {
  return [
    ...repeat(tokenize(note.title), titleWeight),
    ...repeat(tokenize(note.aliases.join(" ")), aliasWeight),
    ...tokenize(note.body),
  ];
}

function repeat(terms: string[], times: number): string[] {
  const result: string[] = [];
  for (let i = 0; i < times; i += 1) result.push(...terms);
  return result;
}

export function tokenize(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/([a-z])([0-9])/g, "$1 $2")
      .match(/[a-z0-9]+/g) ?? []
  ).filter((term) => term.length > 1);
}

function embeddingText(note: Note): string {
  return `${note.title}\n${note.aliases.join(", ")}\n${note.body}`.slice(0, embeddingTextCap);
}

function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) return vector.map(() => 0);
  return vector.map((value) => value / magnitude);
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}
