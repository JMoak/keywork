import type { LayerBootstrap } from "../bootstrap.ts";
import {
  type EmbeddingsPort,
  MemorySearch,
  type RetrievalSource,
  type SearchHit,
  type SearchOptions,
} from "../search.ts";
import type { BootstrapSelection, Note } from "../store.ts";
import { type ArcRegistry, MissingArcError } from "./registry.ts";

export type MemoryLayerRef = { layer: "workspace" } | { layer: "arc"; arc: string };

export type ArcSearchHit = SearchHit & MemoryLayerRef;

export interface ArcRecallOutcome {
  hits: ArcSearchHit[];
  workspaceSource: RetrievalSource;
  arcSource?: RetrievalSource;
}

export interface ArcRecallOptions {
  workspace: MemorySearch;
  registry: ArcRegistry;
  embeddings?: EmbeddingsPort;
  boost?: number;
}

export const defaultArcBoost = 2;

export class ArcRecall {
  private readonly workspace: MemorySearch;
  private readonly registry: ArcRegistry;
  private readonly embeddings: EmbeddingsPort | undefined;
  private readonly boost: number;
  private readonly arcSearches = new Map<string, MemorySearch>();

  constructor(options: ArcRecallOptions) {
    this.workspace = options.workspace;
    this.registry = options.registry;
    this.embeddings = options.embeddings;
    this.boost = options.boost ?? defaultArcBoost;
  }

  async searchAmbient(
    query: string,
    activeArc: string | undefined,
    options: SearchOptions = {},
  ): Promise<ArcRecallOutcome> {
    const workspace = await this.workspace.search(query, options);
    const workspaceHits = workspace.hits.map(taggedWorkspace);
    const arc = await this.ambientArc(activeArc);
    if (arc === undefined) return { hits: workspaceHits, workspaceSource: workspace.source };
    const stratum = await this.arcSearch(arc).search(query, options);
    const boosted = stratum.hits.map((hit) => taggedArc(hit, arc, this.boost));
    return {
      hits: [...workspaceHits, ...boosted].sort((a, b) => b.score - a.score),
      workspaceSource: workspace.source,
      arcSource: stratum.source,
    };
  }

  async searchArc(
    slug: string,
    query: string,
    options: SearchOptions = {},
  ): Promise<ArcRecallOutcome> {
    if ((await this.registry.readArc(slug)) === undefined) throw new MissingArcError(slug);
    const outcome = await this.arcSearch(slug).search(query, options);
    return {
      hits: outcome.hits.map((hit) => taggedArc(hit, slug, 1)),
      workspaceSource: { kind: "lexical" },
      arcSource: outcome.source,
    };
  }

  private async ambientArc(activeArc: string | undefined): Promise<string | undefined> {
    if (activeArc === undefined) return undefined;
    const record = await this.registry.readArc(activeArc);
    return record?.status === "active" ? activeArc : undefined;
  }

  private arcSearch(slug: string): MemorySearch {
    const cached = this.arcSearches.get(slug);
    if (cached !== undefined) return cached;
    const search = new MemorySearch(this.registry.arcStore(slug), this.embeddings);
    this.arcSearches.set(slug, search);
    return search;
  }
}

export async function arcBootstrapLayer(
  registry: ArcRegistry,
  slug: string,
  budget: number,
): Promise<LayerBootstrap> {
  const name = `arc:${slug}`;
  const record = await registry.readArc(slug);
  if (record?.status !== "active") return { name, selection: selectWithinBudget([], budget) };
  const moc = await registry.readMocNote(slug);
  const notes = await registry.arcStore(slug).listNotes();
  return { name, selection: selectArcNotes(moc, notes, budget) };
}

function selectArcNotes(moc: Note | undefined, notes: Note[], budget: number): BootstrapSelection {
  const live = notes.filter((note) => note.supersededBy === undefined);
  const pinned = live.filter((note) => note.pinned);
  const rest = live.filter((note) => !note.pinned);
  const mocFirst = moc === undefined ? [] : [moc];
  return selectWithinBudget(
    [...mocFirst, ...mostUsefulFirst(pinned), ...mostUsefulFirst(rest)],
    budget,
  );
}

function selectWithinBudget(ordered: Note[], budget: number): BootstrapSelection {
  const selected: Note[] = [];
  const skipped: string[] = [];
  let tokens = 0;
  for (const note of ordered) {
    if (tokens + note.tokens > budget) {
      skipped.push(note.name);
      continue;
    }
    selected.push(note);
    tokens += note.tokens;
  }
  return { notes: selected, tokens, budget, skipped };
}

function mostUsefulFirst(notes: Note[]): Note[] {
  const priorOf = (note: Note) => note.usefulness ?? note.confidence ?? 0;
  return [...notes].sort((a, b) => priorOf(b) - priorOf(a));
}

function taggedWorkspace(hit: SearchHit): ArcSearchHit {
  return { ...hit, layer: "workspace" };
}

function taggedArc(hit: SearchHit, arc: string, boost: number): ArcSearchHit {
  return { ...hit, score: hit.score * boost, layer: "arc", arc };
}
