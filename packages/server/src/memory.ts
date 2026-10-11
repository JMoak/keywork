import {
  ArcRecall,
  type ArcRegistry,
  type AuditEntry,
  type CuringStage,
  curingStage,
  type EmbeddingsPort,
  type LayeredSearchHit,
  MemoryGraph,
  MemoryInertError,
  type MemorySearch,
  type MemoryStore,
  MissingArcError,
  type Note,
  type RetrievalSource,
  type SearchHit,
  type StagedItem,
  titleKey,
} from "@keywork/engine";
import type { EventLog, ServerEvents } from "./events.ts";
import type {
  AirlockDigest,
  GardenerActivity,
  InboxItem,
  MemoryAirlock,
  MemoryGarden,
  MemoryHost,
  MemoryLayer,
  MemoryLayerKind,
  MemoryNote,
  MemoryQueryHit,
  MemoryQueryOutcome,
  NoteRelation,
} from "./host.ts";

export interface MemoryVault {
  store: MemoryStore;
  search: MemorySearch;
  gardener?: { recallsSinceSweep(): ReadonlyMap<string, number> };
  embeddings?: EmbeddingsPort;
}

export interface OwnedStagedItem {
  bot: string;
  item: StagedItem;
  approve(): Promise<void>;
  discard(): Promise<void>;
}

export interface MemoryWorkspace {
  vault: MemoryVault | undefined;
  arcs?: ArcRegistry | undefined;
  airlock?: MemoryAirlock | undefined;
  botInbox?: (() => Promise<OwnedStagedItem[]>) | undefined;
}

export interface MemoryHostSeams {
  log: EventLog;
  workspace(): Promise<MemoryWorkspace | undefined>;
  bootstrapBudget?: number;
}

export const defaultBootstrapBudget = 4096;
export const askHitLimit = 20;
export const workspaceLayerId = "workspace";

export function arcLayerId(slug: string): string {
  return `arc:${slug}`;
}

export function inboxCount(items: readonly InboxItem[]): ServerEvents["memory.inbox"] {
  const kinds: Record<string, number> = {};
  for (const item of items) kinds[item.kind] = (kinds[item.kind] ?? 0) + 1;
  const sorted = Object.fromEntries(Object.entries(kinds).sort(([a], [b]) => a.localeCompare(b)));
  return { count: items.length, kinds: sorted };
}

export function memoryHost(seams: MemoryHostSeams): MemoryHost {
  const budget = seams.bootstrapBudget ?? defaultBootstrapBudget;
  const recalls = new WeakMap<ArcRegistry, ArcRecall>();
  let announced: string | undefined;

  const open = async (): Promise<TrustedWorkspace | undefined> => {
    const workspace = await seams.workspace();
    const vault = workspace?.vault;
    if (workspace === undefined || vault === undefined || !vault.store.trusted) return undefined;
    return { ...workspace, vault };
  };
  const requireOpen = async (): Promise<TrustedWorkspace> => {
    const workspace = await open();
    if (workspace === undefined) throw new MemoryInertError();
    return workspace;
  };
  const inbox = async (): Promise<InboxItem[]> => {
    const workspace = await open();
    if (workspace === undefined) return [];
    return [
      ...(await workspace.vault.store.listStaged()),
      ...(await ownedItems(workspace)).map(({ bot, item }) => ({ ...item, bot })),
    ];
  };
  const recount = async (): Promise<void> => {
    const payload = inboxCount(await inbox());
    const key = JSON.stringify(payload);
    if (key === announced) return;
    announced = key;
    seams.log.announce("memory.inbox", payload);
  };
  const announcing = async <T>(write: () => Promise<T>): Promise<T> => {
    const outcome = await write();
    await recount();
    return outcome;
  };
  const airlockOf = async (slug: string): Promise<MemoryAirlock> => {
    const { airlock } = await requireOpen();
    if (airlock === undefined) throw new MissingArcError(slug);
    return airlock;
  };

  return {
    trusted: async () => (await open()) !== undefined,
    garden: async () => {
      const workspace = await open();
      if (workspace === undefined) return inertGarden;
      const layers = await loadLayers(workspace, budget);
      const audit = await workspace.vault.store.readAudit();
      return {
        trusted: true,
        layers: layers.map((loaded) => loaded.layer),
        inbox: await inbox(),
        ledger: workspace.vault.store.ledger(),
        audit,
        gardener: gardenerActivity(audit),
        airlocks: await waitingDigests(workspace.airlock, activeArcSlugs(layers)),
      };
    },
    inbox,
    approve: (id) =>
      announcing(async () => {
        const workspace = await requireOpen();
        const owned = await ownedItem(workspace, id);
        if (owned === undefined) return workspace.vault.store.approve(id);
        await owned.approve();
        return undefined;
      }),
    discard: (id) =>
      announcing(async () => {
        const workspace = await requireOpen();
        const owned = await ownedItem(workspace, id);
        if (owned === undefined) await workspace.vault.store.discard(id);
        else await owned.discard();
      }),
    notes: async (layer) => {
      const workspace = await open();
      if (workspace === undefined) return [];
      const layers = await loadLayers(workspace, budget);
      if (layer === undefined) return layers.flatMap((loaded) => loaded.notes);
      return layers.find((loaded) => loaded.layer.id === layer)?.notes;
    },
    note: async (name, layer = workspaceLayerId) => {
      const workspace = await open();
      if (workspace === undefined) return undefined;
      const loaded = (await loadLayers(workspace, budget)).find(
        (found) => found.layer.id === layer,
      );
      const store = loaded === undefined ? undefined : storeOfLayer(workspace, loaded.layer);
      const found = await store?.readNote(name);
      if (found === undefined) return undefined;
      return loaded?.notes.find((note) => note.path === found.path);
    },
    dailyDates: async () => (await open())?.vault.store.listDailyDates() ?? [],
    daily: async (date) => (await open())?.vault.store.readDaily(date) ?? [],
    ledger: async () => (await open())?.vault.store.ledger() ?? [],
    revert: (ledgerId) =>
      announcing(async () => (await requireOpen()).vault.store.revert(ledgerId)),
    ask: async (query, arc) => {
      const workspace = await open();
      if (workspace === undefined) return inertQuery;
      return askWorkspace(workspace, recalls, query, arc);
    },
    airlock: {
      digest: async (slug) => (await open())?.airlock?.digest(slug),
      triageCandidate: (slug, note, choice) =>
        announcing(async () => (await airlockOf(slug)).triageCandidate(slug, note, choice)),
      triageQuestion: (slug, title, choice) =>
        announcing(async () => (await airlockOf(slug)).triageQuestion(slug, title, choice)),
      deliverEligible: (slug) =>
        announcing(async () => (await airlockOf(slug)).deliverEligible(slug)),
      finish: (slug, options) =>
        announcing(async () => (await airlockOf(slug)).finish(slug, options)),
    },
    recount,
  };
}

interface TrustedWorkspace extends MemoryWorkspace {
  vault: MemoryVault;
}

interface LoadedLayer {
  layer: MemoryLayer;
  notes: MemoryNote[];
}

const inertGarden: MemoryGarden = {
  trusted: false,
  layers: [],
  inbox: [],
  ledger: [],
  audit: [],
  gardener: { state: "idle" },
  airlocks: [],
};

const inertQuery: MemoryQueryOutcome = { hits: [], source: "lexical" };

async function ownedItems(workspace: MemoryWorkspace): Promise<OwnedStagedItem[]> {
  return workspace.botInbox === undefined ? [] : workspace.botInbox();
}

async function ownedItem(
  workspace: MemoryWorkspace,
  id: string,
): Promise<OwnedStagedItem | undefined> {
  return (await ownedItems(workspace)).find((owned) => owned.item.id === id);
}

async function loadLayers(workspace: TrustedWorkspace, budget: number): Promise<LoadedLayer[]> {
  const recalls = workspace.vault.gardener?.recallsSinceSweep() ?? new Map<string, number>();
  return [
    await workspaceLayer(workspace.vault, budget, recalls),
    ...(await activeArcLayers(workspace.arcs, recalls)),
  ];
}

async function workspaceLayer(
  vault: MemoryVault,
  budget: number,
  recalls: ReadonlyMap<string, number>,
): Promise<LoadedLayer> {
  const notes = await vault.store.listNotes();
  const selection = await vault.store.bootstrap(budget);
  const injected = new Set(selection.notes.map((note) => note.name));
  const ordered = [...selection.notes, ...notes.filter((note) => !injected.has(note.name))];
  const decorated = decorate(ordered, workspaceLayerId, recalls, injected);
  return {
    layer: {
      ...layerSummary(workspaceLayerId, "workspace", workspaceLayerId, decorated),
      prompt: { budget, used: selection.tokens },
    },
    notes: decorated,
  };
}

async function activeArcLayers(
  registry: ArcRegistry | undefined,
  recalls: ReadonlyMap<string, number>,
): Promise<LoadedLayer[]> {
  if (registry === undefined) return [];
  const layers: LoadedLayer[] = [];
  for (const arc of await registry.listArcs()) {
    if (arc.status !== "active") continue;
    const id = arcLayerId(arc.slug);
    const notes = await registry.arcStore(arc.slug).listNotes();
    const decorated = decorate(notes, id, recalls, new Set());
    layers.push({
      layer: { ...layerSummary(id, "arc", arc.slug, decorated), arc: arc.slug },
      notes: decorated,
    });
  }
  return layers;
}

function layerSummary(
  id: string,
  kind: MemoryLayerKind,
  label: string,
  notes: readonly MemoryNote[],
): MemoryLayer {
  return { id, kind, label, notes: notes.length, curing: curingTally(notes) };
}

function curingTally(notes: readonly MemoryNote[]): Record<CuringStage, number> {
  const tally: Record<CuringStage, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const note of notes) tally[note.curing] += 1;
  return tally;
}

function decorate(
  notes: readonly Note[],
  layer: string,
  recalls: ReadonlyMap<string, number>,
  injected: ReadonlySet<string>,
): MemoryNote[] {
  const graph = MemoryGraph.fromNotes(notes);
  return notes.map((note) => ({
    ...note,
    layer,
    curing: curingStage(note),
    injected: injected.has(note.name),
    recalls: recalls.get(note.name) ?? 0,
    relations: relationsOf(graph, note),
  }));
}

function relationsOf(graph: MemoryGraph, note: Note): NoteRelation[] {
  const key = titleKey(note.name);
  return graph.edges.flatMap((edge): NoteRelation[] => {
    if (titleKey(edge.subject) === key)
      return [{ name: edge.object, predicate: edge.predicate, direction: "out" }];
    if (titleKey(edge.object) === key)
      return [{ name: edge.subject, predicate: edge.predicate, direction: "in" }];
    return [];
  });
}

function storeOfLayer(workspace: TrustedWorkspace, layer: MemoryLayer): MemoryStore | undefined {
  if (layer.arc === undefined) return workspace.vault.store;
  return workspace.arcs?.arcStore(layer.arc);
}

function activeArcSlugs(layers: readonly LoadedLayer[]): string[] {
  return layers.flatMap((loaded) => loaded.layer.arc ?? []);
}

async function waitingDigests(
  airlock: MemoryAirlock | undefined,
  arcs: readonly string[],
): Promise<AirlockDigest[]> {
  if (airlock === undefined) return [];
  const digests: AirlockDigest[] = [];
  for (const slug of arcs) {
    const digest = await airlock.digest(slug);
    if (digest !== undefined) digests.push(digest);
  }
  return digests;
}

function gardenerActivity(audit: readonly AuditEntry[]): GardenerActivity {
  const swept = audit.filter((entry) => entry.event.startsWith("gardener sweep")).at(-1);
  return swept === undefined ? { state: "idle" } : { state: "idle", sweptAt: swept.timestamp };
}

async function askWorkspace(
  workspace: TrustedWorkspace,
  recalls: WeakMap<ArcRegistry, ArcRecall>,
  query: string,
  arc: string | undefined,
): Promise<MemoryQueryOutcome> {
  const registry = workspace.arcs;
  if (registry === undefined || arc === undefined) {
    const outcome = await workspace.vault.search.search(query, { limit: askHitLimit });
    return queryOutcome(outcome.hits.map(workspaceHit), outcome.source);
  }
  const recall = recalls.get(registry) ?? arcRecallOver(workspace.vault, registry);
  recalls.set(registry, recall);
  const outcome = await recall.searchAmbient(query, arc, { limit: askHitLimit });
  return queryOutcome(
    outcome.hits.map((hit) => layeredHit(hit, recall.boost)),
    outcome.workspaceSource,
  );
}

function arcRecallOver(vault: MemoryVault, registry: ArcRegistry): ArcRecall {
  return new ArcRecall({
    workspace: vault.search,
    registry,
    ...(vault.embeddings !== undefined && { embeddings: vault.embeddings }),
  });
}

function queryOutcome(hits: MemoryQueryHit[], source: RetrievalSource): MemoryQueryOutcome {
  return {
    hits,
    source: source.kind,
    ...(source.kind !== "lexical" && { embeddings: source.embeddings }),
  };
}

function workspaceHit(hit: SearchHit): MemoryQueryHit {
  return {
    note: hit.note.name,
    layer: workspaceLayerId,
    ranks: hit.ranks,
    superseded: hit.superseded,
  };
}

function layeredHit(hit: LayeredSearchHit, boost: number): MemoryQueryHit {
  switch (hit.layer) {
    case "workspace":
      return workspaceHit(hit);
    case "arc":
      return { ...workspaceHit(hit), layer: arcLayerId(hit.arc), boost };
    case "bot":
      return { ...workspaceHit(hit), layer: `bot:${hit.bot}`, boost };
  }
}
