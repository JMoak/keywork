import { join } from "node:path";
import {
  type ArcRegistry,
  type AuditEntry,
  MemoryGraph,
  type MemoryStore,
  type Note,
  type StagedItem,
  sourceForgetting,
  titleKey,
  workspaceOrCraftStore,
} from "@keywork/engine";
import type {
  ArcAirlockPort,
  ArcCloseDigestRecord,
  ForgettingMemoryPort,
  GardenerActivity,
  MemoryLayerRecord,
  MemoryNoteDetail,
  MemoryNoteRecord,
  NoteRelation,
} from "@keywork/server";
import type { ArcService } from "./arcs.ts";
import type { BotMemory, BotStagedItem } from "./bot-memory.ts";
import {
  arcLayerId,
  type MemoryAccess,
  memoryBootstrapBudget,
  memoryPanePort,
  type WorkspaceMemory,
  workspaceLayerId,
} from "./memory.ts";

export interface ServedMemoryOptions {
  memory: MemoryAccess;
  arcs?: ArcService | undefined;
  bots?: BotMemory | undefined;
}

export function servedMemory(options: ServedMemoryOptions): ForgettingMemoryPort {
  const { memory, arcs, bots } = options;
  const pane = memoryPanePort(memory, arcs?.registry, arcs?.port.airlock, bots);
  const staging = stagingChanges(memory);
  const opened = (): WorkspaceMemory | undefined => {
    const workspace = staging.watch(memory());
    return workspace?.store.trusted === true ? workspace : undefined;
  };
  const requireMemory = (): WorkspaceMemory => {
    const workspace = opened();
    if (workspace === undefined) throw new Error("memory isn't set up here yet · /init sets it up");
    return workspace;
  };
  const registry = (): ArcRegistry | undefined => arcs?.registry();
  const airlock: ArcAirlockPort = arcs?.port.airlock ?? closedAirlock;
  const botStaged = async (): Promise<BotStagedItem[]> => (bots === undefined ? [] : bots.staged());
  const inbox = async (): Promise<StagedItem[]> => {
    const workspace = opened();
    if (workspace === undefined) return [];
    return [
      ...(await workspace.store.listStaged()),
      ...(await botStaged()).map(({ item }) => item),
    ];
  };
  const layers = (): Promise<LoadedLayer[]> => loadLayers(requireMemory(), registry(), bots);
  const craftStore = (slug: string): MemoryStore => {
    const layer = bots?.layers().find(({ bot }) => bot.name === slug);
    if (layer === undefined) throw new Error(`no creature here is called ${slug}`);
    return layer.registry.botStore(slug);
  };
  return {
    forgetting: sourceForgetting((source) =>
      workspaceOrCraftStore(requireMemory().store, craftStore)(source),
    ),
    trusted: () => opened() !== undefined,
    overview: async () => {
      const workspace = requireMemory();
      const loaded = await layers();
      const audit = await workspace.store.readAudit();
      return {
        layers: loaded.map((layer) => layer.layer),
        inbox: await inbox(),
        ledger: workspace.store.ledger(),
        audit,
        gardener: gardenerActivity(audit),
        airlocks: await waitingDigests(airlock, loaded),
      };
    },
    inbox,
    approve: async (id) => {
      const owned = (await botStaged()).find(({ item }) => item.id === id);
      if (owned !== undefined && bots !== undefined) {
        await bots.approve(owned);
        return undefined;
      }
      return requireMemory().store.approve(id);
    },
    discard: (id) => pane.discard(id),
    notes: async () => (await layers()).flatMap((layer) => layer.notes),
    note: async (name, layer) => {
      const key = titleKey(name);
      for (const loaded of await layers()) {
        if (layer !== undefined && loaded.layer.id !== layer) continue;
        const found = loaded.notes.find((note) => titleKey(note.name) === key);
        if (found !== undefined) return withRelations(found, loaded.notes);
      }
      return undefined;
    },
    dailyDates: () => requireMemory().store.listDailyDates(),
    daily: (date) => requireMemory().store.readDaily(date),
    ledger: () => requireMemory().store.ledger(),
    revert: (ledgerId) => requireMemory().store.revert(ledgerId),
    query: async (text, arc) =>
      pane.query === undefined ? { hits: [], source: "lexical" } : pane.query(text, arc),
    airlock,
    subscribe: (listener) => {
      const stopStaging = staging.subscribe(listener);
      opened();
      const stopArcs = arcs?.port.subscribe?.(listener);
      return () => {
        stopStaging();
        stopArcs?.();
      };
    },
  };
}

export function stagedInbox(memory: MemoryAccess): () => readonly StagedItem[] {
  let items: readonly StagedItem[] = [];
  const staging = stagingChanges(memory);
  const reload = (): void => {
    const store = memory()?.store;
    if (store?.trusted !== true) return;
    void store.listStaged().then(
      (listed) => {
        items = listed;
      },
      () => undefined,
    );
  };
  let watching = false;
  const follow = (): void => {
    if (watching || memory()?.store.trusted !== true) return;
    watching = true;
    staging.watch(memory());
    reload();
  };
  staging.subscribe(reload);
  follow();
  return () => {
    follow();
    return items;
  };
}

interface StagingChanges {
  watch(workspace: WorkspaceMemory | undefined): WorkspaceMemory | undefined;
  subscribe(listener: () => void): () => void;
}

function stagingChanges(memory: MemoryAccess): StagingChanges {
  const listeners = new Set<() => void>();
  const watched = new WeakSet<MemoryStore>();
  const announce = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const changes: StagingChanges = {
    watch: (workspace) => {
      if (workspace !== undefined && !watched.has(workspace.store)) {
        watched.add(workspace.store);
        workspace.store.onStaged(announce);
      }
      return workspace;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      changes.watch(memory());
      return () => listeners.delete(listener);
    },
  };
  return changes;
}

interface LoadedLayer {
  layer: MemoryLayerRecord;
  notes: MemoryNoteRecord[];
}

const closedAirlock: ArcAirlockPort = {
  digest: async () => undefined,
  triageCandidate: async (slug) => {
    throw new Error(`arc ${slug} has nothing at the airlock`);
  },
  triageQuestion: async (slug) => {
    throw new Error(`arc ${slug} has nothing at the airlock`);
  },
  deliverEligible: async () => 0,
  finish: async () => ({ kind: "undecided", items: [] }),
};

async function loadLayers(
  memory: WorkspaceMemory,
  registry: ArcRegistry | undefined,
  bots: BotMemory | undefined,
): Promise<LoadedLayer[]> {
  const recalls = memory.gardener.recallsSinceSweep();
  return [
    await workspaceLayer(memory, recalls),
    ...(await activeArcLayers(memory, registry, recalls)),
    ...(await botLayers(bots, recalls)),
  ];
}

export function botLayerId(slug: string): string {
  return `bot:${slug}`;
}

async function botLayers(
  bots: BotMemory | undefined,
  recalls: ReadonlyMap<string, number>,
): Promise<LoadedLayer[]> {
  if (bots === undefined) return [];
  const layers: LoadedLayer[] = [];
  for (const { bot, registry } of bots.layers()) {
    const store = registry.botStore(bot.name);
    const id = botLayerId(bot.name);
    layers.push({
      layer: { id, kind: "bot", label: bot.name },
      notes: (await store.listNotes()).map((note) =>
        noteRecord(note, id, store.vaultRoot, recalls, false),
      ),
    });
  }
  return layers;
}

async function workspaceLayer(
  memory: WorkspaceMemory,
  recalls: ReadonlyMap<string, number>,
): Promise<LoadedLayer> {
  const notes = await memory.store.listNotes();
  const selection = await memory.store.bootstrap(memoryBootstrapBudget);
  const injected = new Set(selection.notes.map((note) => note.name));
  const ordered = [...selection.notes, ...notes.filter((note) => !injected.has(note.name))];
  return {
    layer: {
      id: workspaceLayerId,
      kind: "workspace",
      label: "workspace",
      prompt: { budget: memoryBootstrapBudget, used: selection.tokens },
    },
    notes: ordered.map((note) =>
      noteRecord(note, workspaceLayerId, memory.vaultRoot, recalls, injected.has(note.name)),
    ),
  };
}

async function activeArcLayers(
  memory: WorkspaceMemory,
  registry: ArcRegistry | undefined,
  recalls: ReadonlyMap<string, number>,
): Promise<LoadedLayer[]> {
  if (registry === undefined) return [];
  const layers: LoadedLayer[] = [];
  for (const arc of await registry.listArcs()) {
    if (arc.status !== "active") continue;
    const root = join(memory.vaultRoot, "arcs", arc.slug);
    const id = arcLayerId(arc.slug);
    layers.push({
      layer: { id, kind: "arc", label: arc.slug, arc: arc.slug },
      notes: (await registry.arcStore(arc.slug).listNotes()).map((note) =>
        noteRecord(note, id, root, recalls, false),
      ),
    });
  }
  return layers;
}

function noteRecord(
  note: Note,
  layer: string,
  root: string,
  recalls: ReadonlyMap<string, number>,
  injected: boolean,
): MemoryNoteRecord {
  return {
    ...note,
    layer,
    file: join(root, note.path),
    injected,
    recalls: recalls.get(note.name) ?? 0,
  };
}

function withRelations(note: MemoryNoteRecord, siblings: readonly Note[]): MemoryNoteDetail {
  const graph = MemoryGraph.fromNotes(siblings);
  const key = titleKey(note.name);
  const relations = graph.edges.flatMap((edge): NoteRelation[] => {
    if (titleKey(edge.subject) === key)
      return [{ name: edge.object, predicate: edge.predicate, direction: "out" }];
    if (titleKey(edge.object) === key)
      return [{ name: edge.subject, predicate: edge.predicate, direction: "in" }];
    return [];
  });
  return { ...note, relations };
}

async function waitingDigests(
  airlock: ArcAirlockPort,
  layers: readonly LoadedLayer[],
): Promise<ArcCloseDigestRecord[]> {
  const digests: ArcCloseDigestRecord[] = [];
  for (const { layer } of layers) {
    if (layer.arc === undefined) continue;
    const digest = await airlock.digest(layer.arc);
    if (digest !== undefined) digests.push(digest);
  }
  return digests;
}

function gardenerActivity(audit: readonly AuditEntry[]): GardenerActivity {
  const swept = audit.filter((entry) => entry.event.startsWith("gardener sweep")).at(-1);
  return { state: "idle", ...(swept !== undefined && { sweptAt: swept.timestamp }) };
}
