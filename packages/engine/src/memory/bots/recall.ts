import { botLayer, isLayeredHit, type LayeredSearchHit } from "../arcs/recall.ts";
import {
  type BootstrapSelection,
  type LayerBootstrap,
  mostUsefulFirst,
  selectWithinBudget,
} from "../bootstrap.ts";
import type { Note } from "../notes.ts";
import {
  applySupersededFloor,
  type EmbeddingsPort,
  MemorySearch,
  type MemorySearcher,
  type RetrievalSource,
  type SearchHit,
  type SearchOptions,
} from "../search.ts";
import { type BotRegistry, MissingBotLayerError } from "./registry.ts";

export interface BotRecallOutcome {
  hits: LayeredSearchHit[];
  source: RetrievalSource;
  botSource?: RetrievalSource;
}

export interface BotRecallOptions {
  base: MemorySearcher;
  registry: BotRegistry;
  embeddings?: EmbeddingsPort;
  boost?: number;
}

export const defaultBotBoost = 2;

export class BotRecall {
  readonly boost: number;
  private readonly base: MemorySearcher;
  private readonly registry: BotRegistry;
  private readonly embeddings: EmbeddingsPort | undefined;
  private readonly botSearches = new Map<string, MemorySearch>();

  constructor(options: BotRecallOptions) {
    this.base = options.base;
    this.registry = options.registry;
    this.embeddings = options.embeddings;
    this.boost = options.boost ?? defaultBotBoost;
  }

  async searchAmbient(
    query: string,
    activeBot: string | undefined,
    options: SearchOptions = {},
  ): Promise<BotRecallOutcome> {
    const beneath = await this.base.search(query, options);
    const beneathHits = beneath.hits.map(taggedBeneath);
    const bot = await this.ambientBot(activeBot);
    if (bot === undefined) return { hits: beneathHits, source: beneath.source };
    const stratum = await this.botSearch(bot).search(query, options);
    const boosted = stratum.hits.map((hit) => taggedBot(hit, bot, this.boost));
    return {
      hits: applySupersededFloor([...beneathHits, ...boosted].sort((a, b) => b.score - a.score)),
      source: beneath.source,
      botSource: stratum.source,
    };
  }

  async searchBot(
    slug: string,
    query: string,
    options: SearchOptions = {},
  ): Promise<BotRecallOutcome> {
    if ((await this.registry.readBot(slug)) === undefined) throw new MissingBotLayerError(slug);
    const outcome = await this.botSearch(slug).search(query, options);
    return {
      hits: outcome.hits.map((hit) => taggedBot(hit, slug, 1)),
      source: { kind: "lexical" },
      botSource: outcome.source,
    };
  }

  private async ambientBot(activeBot: string | undefined): Promise<string | undefined> {
    if (activeBot === undefined) return undefined;
    const record = await this.registry.readBot(activeBot);
    return record?.status === "active" ? activeBot : undefined;
  }

  private botSearch(slug: string): MemorySearch {
    const cached = this.botSearches.get(slug);
    if (cached !== undefined) return cached;
    const search = new MemorySearch(this.registry.botStore(slug), this.embeddings);
    this.botSearches.set(slug, search);
    return search;
  }
}

export async function botBootstrapLayer(
  registry: BotRegistry,
  slug: string,
  budget: number,
): Promise<LayerBootstrap> {
  const name = botLayer(slug);
  const record = await registry.readBot(slug);
  if (record?.status !== "active") return { name, selection: selectWithinBudget([], budget) };
  const moc = await registry.readMocNote(slug);
  const notes = await registry.botStore(slug).listNotes();
  return { name, selection: selectBotNotes(moc, notes, budget) };
}

function selectBotNotes(moc: Note | undefined, notes: Note[], budget: number): BootstrapSelection {
  const live = notes.filter((note) => note.supersededBy === undefined);
  const pinned = live.filter((note) => note.pinned);
  const rest = live.filter((note) => !note.pinned);
  const mocFirst = moc === undefined ? [] : [moc];
  return selectWithinBudget(
    [...mocFirst, ...mostUsefulFirst(pinned), ...mostUsefulFirst(rest)],
    budget,
  );
}

function taggedBeneath(hit: SearchHit): LayeredSearchHit {
  return isLayeredHit(hit) ? hit : { ...hit, layer: "workspace" };
}

function taggedBot(hit: SearchHit, bot: string, boost: number): LayeredSearchHit {
  return { ...hit, score: hit.score * boost, layer: "bot", bot };
}
