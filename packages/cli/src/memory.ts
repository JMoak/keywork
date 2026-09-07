import { join } from "node:path";
import {
  ArcRecall,
  type ArcRegistry,
  AskGateLedger,
  type AuditEntry,
  type BootstrapInjection,
  bootstrapMemory,
  CitationLedger,
  citationAuditEvent,
  citationUsefulnessFeed,
  type EmbeddingsPort,
  Gardener,
  type LayeredSearchHit,
  type LedgerEntry,
  MemoryGraph,
  type MemoryRecall,
  MemorySearch,
  MemoryStore,
  type Note,
  noteName,
  type Provenance,
  parseCitationEvents,
  type RecallTap,
  type RetrievalSource,
  readSkillTelemetry,
  type SearchHit,
  type SkillEvidence,
  type SkillLibrary,
  type StagedItem,
  type StagedWrite,
  titleKey,
} from "@keywork/engine";
import { resolveVaultPath, toError } from "@keywork/shared";
import type {
  AirlockDigestView,
  ArcAirlockPort,
  CuringStage,
  InboxItemView,
  LedgerEventView,
  MemoryLayerView,
  MemoryNoteView,
  MemoryPaneInputs,
  MemoryPanePort,
  MemoryQueryHit,
  MemoryQueryOutcome,
  NoteRelationView,
} from "@keywork/tui";
import type { ArcService } from "./arcs.ts";
import type { BotMemory, BotStagedItem } from "./bot-memory.ts";

export interface WorkspaceMemory {
  vaultRoot: string;
  store: MemoryStore;
  search: MemorySearch;
  gardener: Gardener;
  askGate: AskGateLedger;
  embeddings?: EmbeddingsPort;
}

export type MemoryAccess = () => WorkspaceMemory | undefined;

export const memoryBootstrapBudget = 4096;

export function workspaceMemoryAccess(cwd: string, trusted: boolean, slug?: string): MemoryAccess {
  let opened: WorkspaceMemory | undefined;
  return () => {
    opened ??= openWorkspaceMemory(cwd, trusted, slug);
    return opened;
  };
}

export function openWorkspaceMemory(
  cwd: string,
  trusted: boolean,
  slug?: string,
): WorkspaceMemory | undefined {
  const vaultRoot = resolveVaultPath(cwd, slug);
  if (vaultRoot === undefined) return undefined;
  const store = new MemoryStore({ vaultRoot, trusted });
  return {
    vaultRoot,
    store,
    search: new MemorySearch(store),
    gardener: new Gardener({ store }),
    askGate: trusted
      ? new AskGateLedger({ filePath: join(vaultRoot, ".staging", "ask-gate.json") })
      : new AskGateLedger(),
  };
}

export type SessionKey = string | (() => string | undefined);

export function memoryRecall(
  memory: WorkspaceMemory | undefined,
  sessionId?: SessionKey,
  onRetrieval?: (disclosure: string) => void,
  arcs?: ArcService,
  bots?: BotMemory,
): MemoryRecall | undefined {
  if (memory === undefined) return undefined;
  const workspace = recallSearch(memory, onRetrieval);
  if (sessionId === undefined) return { store: memory.store, search: workspace };
  const layered =
    arcs === undefined ? workspace : arcs.searcher(workspace, sessionId, memory.embeddings);
  const search =
    bots === undefined ? layered : bots.searcher(layered, sessionId, memory.embeddings);
  return { store: memory.store, search };
}

export function resolveSessionKey(key: SessionKey | undefined): string | undefined {
  return typeof key === "function" ? key() : key;
}

export interface CitationTrail {
  forSession(sessionId: string): CitationLedger;
  tapFor(sessionKey: SessionKey | undefined): RecallTap;
  recordReply(sessionId: string, replyText: string): void;
  recordBootstrap(sessionId: string, injection: BootstrapInjection): void;
  citedNotes(arc: string): Promise<string[]>;
  release(sessionId: string): void;
}

export function citationTrail(
  memory: MemoryAccess,
  bootstrap?: () => BootstrapInjection | undefined,
): CitationTrail {
  const ledgers = new Map<string, CitationLedger>();
  const persist = (line: string): void => {
    const opened = memory();
    if (opened === undefined || !opened.store.trusted) return;
    void opened.store.recordAudit(line).catch(() => undefined);
  };
  const forSession = (sessionId: string): CitationLedger => {
    const existing = ledgers.get(sessionId);
    if (existing !== undefined) return existing;
    const created = new CitationLedger({
      session: sessionId,
      onEvent: (event) => persist(citationAuditEvent(event)),
      onCitation: (event) => {
        const opened = memory();
        if (opened !== undefined) citationUsefulnessFeed(opened.gardener, sessionId)(event);
      },
    });
    const injection = bootstrap?.();
    if (injection !== undefined) created.recordBootstrap(injection);
    ledgers.set(sessionId, created);
    return created;
  };
  const liveCitations = (layer: string): string[] =>
    [...ledgers.values()].flatMap((ledger) =>
      ledger
        .citations()
        .filter((event) => event.layer === layer)
        .map((event) => event.note),
    );
  const persistedCitations = async (layer: string): Promise<string[]> => {
    const opened = memory();
    if (opened === undefined) return [];
    return parseCitationEvents(await opened.store.readAudit())
      .filter((event) => event.kind === "citation" && event.layer === layer)
      .map((event) => event.note);
  };
  return {
    forSession,
    tapFor: (sessionKey) => ({
      recordRecall: (note, surface, layer) => {
        const id = resolveSessionKey(sessionKey);
        if (id !== undefined) forSession(id).recordRecall(note, surface, layer);
      },
      recordLatency: (surface, milliseconds) => {
        const id = resolveSessionKey(sessionKey);
        if (id !== undefined) forSession(id).recordLatency(surface, milliseconds);
      },
    }),
    recordReply: (sessionId, replyText) => {
      forSession(sessionId).recordReply(replyText);
    },
    recordBootstrap: (sessionId, injection) => {
      forSession(sessionId).recordBootstrap(injection);
    },
    citedNotes: async (arc) => {
      const layer = arcLayerId(arc);
      return [...new Set([...liveCitations(layer), ...(await persistedCitations(layer))])];
    },
    release: (sessionId) => {
      ledgers.delete(sessionId);
    },
  };
}

export function retrievalDisclosure(source: RetrievalSource): string | undefined {
  switch (source.kind) {
    case "lexical":
      return undefined;
    case "hybrid":
      return `memory search uses embeddings from ${source.embeddings}`;
    case "lexical-degraded":
      return `memory search fell back to lexical, embeddings from ${source.embeddings} aren't available`;
  }
}

function recallSearch(
  memory: WorkspaceMemory,
  onRetrieval?: (disclosure: string) => void,
): MemorySearch {
  if (onRetrieval === undefined) return memory.search;
  return new MemorySearch(memory.store, memory.embeddings, ({ source }) => {
    const disclosure = retrievalDisclosure(source);
    if (disclosure !== undefined) onRetrieval(disclosure);
  });
}

export async function bootstrapInjection(
  memory: WorkspaceMemory | undefined,
): Promise<BootstrapInjection | undefined> {
  if (memory === undefined) return undefined;
  return bootstrapMemory([
    { name: workspaceLayerId, store: memory.store, budget: memoryBootstrapBudget },
  ]);
}

export function withMemoryPrompt(systemPrompt: string, injection: string): string {
  return injection === "" ? systemPrompt : `${systemPrompt}\n\n${injection}`;
}

export async function skillEvidenceOf(
  library: SkillLibrary,
  telemetryFile: string,
): Promise<SkillEvidence> {
  return { skills: library.skills(), telemetry: await readSkillTelemetry(telemetryFile) };
}

export async function sweepOnClose(
  memory: WorkspaceMemory | undefined,
  skills?: SkillEvidence,
): Promise<void> {
  if (memory === undefined) return;
  const failures: Error[] = [];
  const attempt = (work: () => Promise<unknown>): Promise<void> =>
    work().then(
      () => undefined,
      (cause: unknown) => {
        failures.push(toError(cause));
      },
    );
  await attempt(() => memory.gardener.sweep(skills === undefined ? {} : { skills }));
  if (memory.store.trusted) await attempt(() => memory.askGate.proposePreferences(memory.store));
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `memory close: ${failures.map((failure) => failure.message).join(" · ")}`,
    );
  }
}

export type ArcRegistryAccess = () => ArcRegistry | undefined;

export function memoryPanePort(
  memory: MemoryAccess,
  arcs?: ArcRegistryAccess,
  airlock?: ArcAirlockPort,
  bots?: BotMemory,
): MemoryPanePort {
  const store = (): MemoryStore => {
    const opened = memory();
    if (opened === undefined) throw new Error("memory isn't set up here yet · /init sets it up");
    return opened.store;
  };
  const botStaged = async (id: string): Promise<BotStagedItem | undefined> =>
    (await botStagedItems(bots)).find(({ item }) => item.id === id);
  const stagedOwner = async (id: string): Promise<MemoryStore> => {
    const owned = await botStaged(id);
    return owned === undefined ? store() : owned.registry.botStore(owned.bot.name);
  };
  const recalls = new WeakMap<ArcRegistry, ArcRecall>();
  return {
    load: () => loadInputs(memory(), arcs?.(), airlock, bots),
    approve: async (id) => {
      const owned = await botStaged(id);
      if (owned !== undefined && bots !== undefined) await bots.approve(owned);
      else await store().approve(id);
    },
    discard: async (id) => (await stagedOwner(id)).discard(id),
    revert: (ledgerId) => store().revert(ledgerId),
    query: (text, arc) => askMemory(memory(), arcs?.(), recalls, text, arc),
    ...(airlock !== undefined && { airlock }),
  };
}

export const workspaceLayerId = "workspace";

export function arcLayerId(slug: string): string {
  return `arc:${slug}`;
}

export function botLayerId(slug: string): string {
  return `bot:${slug}`;
}

export function curingStage(note: Note): CuringStage {
  if (note.provenance === "user" || note.pinned) return 3;
  const usefulness = note.usefulness ?? 0;
  if (usefulness >= settledUsefulness) return 3;
  if (usefulness > 0) return 2;
  return note.confidence === undefined ? 0 : 1;
}

const settledUsefulness = 0.5;
const emptyMemoryPane: MemoryPaneInputs = { layers: [], notes: [], inbox: [], ledger: [] };

interface LoadedLayer {
  layer: MemoryLayerView;
  notes: MemoryNoteView[];
}

async function loadInputs(
  memory: WorkspaceMemory | undefined,
  registry: ArcRegistry | undefined,
  airlock: ArcAirlockPort | undefined,
  bots: BotMemory | undefined,
): Promise<MemoryPaneInputs> {
  if (memory === undefined || !memory.store.trusted) return emptyMemoryPane;
  const recalls = memory.gardener.recallsSinceSweep();
  const workspace = await workspaceLayer(memory, recalls);
  const arcLayers = await activeArcLayers(memory, registry, recalls);
  const audit = await memory.store.readAudit();
  const layers = [workspace, ...arcLayers];
  return {
    layers: layers.map((loaded) => loaded.layer),
    notes: layers.flatMap((loaded) => loaded.notes),
    inbox: [
      ...(await memory.store.listStaged()).map(inboxView),
      ...(await botStagedItems(bots)).map(botInboxView),
    ],
    ledger: [...memory.store.ledger().map(ledgerOpView), ...audit.map(auditView)],
    gardener: { state: "idle", ...lastSweep(audit) },
    airlocks: await waitingDigests(
      airlock,
      arcLayers.flatMap((loaded) => loaded.layer.arc ?? []),
    ),
  };
}

async function waitingDigests(
  airlock: ArcAirlockPort | undefined,
  arcs: readonly string[],
): Promise<AirlockDigestView[]> {
  if (airlock === undefined) return [];
  const digests: AirlockDigestView[] = [];
  for (const slug of arcs) {
    const digest = await airlock.digest(slug);
    if (digest !== undefined) digests.push(digest);
  }
  return digests;
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
    notes: noteViews(ordered, workspaceLayerId, memory.vaultRoot, recalls, injected),
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
    const notes = await registry.arcStore(arc.slug).listNotes();
    const root = join(memory.vaultRoot, "arcs", arc.slug);
    layers.push({
      layer: { id: arcLayerId(arc.slug), kind: "arc", label: arc.slug, arc: arc.slug },
      notes: noteViews(notes, arcLayerId(arc.slug), root, recalls, new Set()),
    });
  }
  return layers;
}

function noteViews(
  notes: readonly Note[],
  layer: string,
  root: string,
  recalls: ReadonlyMap<string, number>,
  injected: ReadonlySet<string>,
): MemoryNoteView[] {
  const graph = MemoryGraph.fromNotes(notes);
  return notes.map((note) => ({
    name: note.name,
    title: note.title,
    layer,
    path: note.path,
    file: join(root, note.path),
    provenance: note.provenance,
    curing: curingStage(note),
    links: note.links,
    aliases: note.aliases,
    body: note.body,
    tokens: note.tokens,
    pinned: note.pinned,
    injected: injected.has(note.name),
    recalls: recalls.get(note.name) ?? 0,
    relations: relationsOf(graph, note),
    ...(note.created !== undefined && { created: note.created }),
    ...(note.usefulness !== undefined && { usefulness: note.usefulness }),
    ...(note.confidence !== undefined && { confidence: note.confidence }),
    ...(note.supersedes !== undefined && { supersedes: note.supersedes }),
    ...(note.supersededBy !== undefined && { supersededBy: note.supersededBy }),
    ...(note.delivered !== undefined && { delivered: note.delivered }),
    ...(note.distilledFrom !== undefined && { distilledFrom: note.distilledFrom }),
  }));
}

function relationsOf(graph: MemoryGraph, note: Note): NoteRelationView[] {
  const key = titleKey(note.name);
  return graph.edges.flatMap((edge): NoteRelationView[] => {
    if (titleKey(edge.subject) === key)
      return [{ name: edge.object, predicate: edge.predicate, direction: "out" }];
    if (titleKey(edge.object) === key)
      return [{ name: edge.subject, predicate: edge.predicate, direction: "in" }];
    return [];
  });
}

async function botStagedItems(bots: BotMemory | undefined): Promise<BotStagedItem[]> {
  return bots === undefined ? [] : bots.staged();
}

function botInboxView({ bot, item }: BotStagedItem): InboxItemView {
  const view = inboxView(item);
  return { ...view, title: `${bot.sigil} ${view.title}` };
}

function inboxView(item: StagedItem): InboxItemView {
  const base = { id: item.id, created: item.created } as const;
  switch (item.kind) {
    case "note":
    case "daily":
    case "moc":
      return stagedWriteView(item, base);
    case "borderline-promotion":
      return {
        ...base,
        kind: "promotion",
        title: item.title,
        provenance: "agent",
        detail: `from ${item.source}`,
        note: item.title,
      };
    case "contradiction":
      return {
        ...base,
        kind: "contradiction",
        title: `${item.a} vs ${item.b}`,
        provenance: worseProvenance(item.aProvenance, item.bProvenance),
      };
    case "merge-proposal":
      return {
        ...base,
        kind: "proposal",
        title: `merge ${item.retire} into ${item.keep}`,
        provenance: "agent",
        note: item.keep,
      };
    case "supersession-proposal":
      return {
        ...base,
        kind: "proposal",
        title: `${item.winner} supersedes ${item.loser}`,
        provenance: "agent",
        note: item.winner,
      };
    case "link-proposal":
      return {
        ...base,
        kind: "proposal",
        title: `link ${item.note} → ${item.target}`,
        provenance: "agent",
        note: item.note,
      };
    case "arc-distillation":
      return {
        ...base,
        kind: "airlock",
        title: `deliver ${item.note}`,
        provenance: "agent",
        detail: item.eligible ? "eligible" : "below bar",
        arc: item.arc,
        note: item.note,
      };
    case "arc-question":
      return {
        ...base,
        kind: "airlock",
        title: `triage ${item.note}`,
        provenance: "agent",
        arc: item.arc,
        note: item.note,
      };
    case "preference-proposal":
      return {
        ...base,
        kind: "proposal",
        title: `allow ${item.toolShape} without asking`,
        provenance: "user",
        detail: `approved ${item.approvals} times in a row`,
      };
    case "skill-proposal":
      return {
        ...base,
        kind: "proposal",
        title: `new skill ${item.name}`,
        provenance: "agent",
        detail: `${item.commands.split("\n").length} steps, seen ${item.occurrences} times`,
      };
    case "skill-review":
      return {
        ...base,
        kind: "proposal",
        title: `${item.reason === "churning" ? "rework" : "retire"} skill ${item.skill}`,
        provenance: "agent",
        detail: `${item.uses} uses, ${item.patches} patches, ${item.rewrites} rewrites`,
      };
  }
}

function stagedWriteView(
  item: StagedWrite,
  base: Pick<InboxItemView, "id" | "created">,
): InboxItemView {
  return {
    ...base,
    kind: "staged",
    title: item.target,
    provenance: "untrusted",
    detail: item.kind,
    ...(item.kind === "note" && { note: noteName(item.target) }),
  };
}

function worseProvenance(a: Provenance, b: Provenance): Provenance {
  const order: Provenance[] = ["user", "agent", "untrusted"];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

function ledgerOpView(entry: LedgerEntry): LedgerEventView {
  const paths = entry.deltas.map((delta) => delta.path).filter(isNotePath);
  const names = paths.map(noteName);
  const staged = paths.length === 0;
  return {
    id: entry.id,
    at: entry.timestamp,
    verb: staged && entry.op === "create" ? "stage" : entry.op,
    subject: staged ? "staged item" : names.join(", "),
    notes: names.filter((name) => !name.startsWith("daily/")),
  };
}

function isNotePath(path: string): boolean {
  return path.endsWith(".md") && !path.startsWith(".staging/") && path !== "curation.md";
}

function auditView(entry: AuditEntry): LedgerEventView {
  const colon = entry.event.indexOf(": ");
  const space = entry.event.indexOf(" ");
  const split = colon !== -1 ? colon : space;
  const verb = split === -1 ? entry.event : entry.event.slice(0, split);
  const subject = split === -1 ? "" : entry.event.slice(split + (colon !== -1 ? 2 : 1));
  return { at: entry.timestamp, verb, subject, notes: [] };
}

function lastSweep(audit: readonly AuditEntry[]): { sweptAt?: string } {
  const swept = audit.filter((entry) => entry.event.startsWith("gardener sweep")).at(-1);
  return swept === undefined ? {} : { sweptAt: swept.timestamp };
}

async function askMemory(
  memory: WorkspaceMemory | undefined,
  registry: ArcRegistry | undefined,
  recalls: WeakMap<ArcRegistry, ArcRecall>,
  text: string,
  arc: string | undefined,
): Promise<MemoryQueryOutcome> {
  if (memory === undefined || !memory.store.trusted) return { hits: [], source: "lexical" };
  if (registry === undefined || arc === undefined) {
    const outcome = await memory.search.search(text);
    return queryOutcome(outcome.hits.map(workspaceHit), outcome.source);
  }
  const recall = recalls.get(registry) ?? arcRecallOver(memory, registry);
  recalls.set(registry, recall);
  const outcome = await recall.searchAmbient(text, arc);
  return queryOutcome(
    outcome.hits.map((hit) => layeredHit(hit, recall.boost)),
    outcome.workspaceSource,
  );
}

function arcRecallOver(memory: WorkspaceMemory, registry: ArcRegistry): ArcRecall {
  return new ArcRecall({
    workspace: memory.search,
    registry,
    ...(memory.embeddings !== undefined && { embeddings: memory.embeddings }),
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
      return { ...workspaceHit(hit), layer: botLayerId(hit.bot), boost };
  }
}
