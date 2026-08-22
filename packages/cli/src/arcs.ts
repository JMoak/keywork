import {
  ArcAirlock,
  ArcBindings,
  ArcRecall,
  ArcRegistry,
  type EmbeddingsPort,
  type MemorySearch,
  type MemorySearcher,
  type MemoryStore,
  type SessionStore,
} from "@keywork/engine";
import { resolveVaultPath } from "@keywork/shared";
import type { ArcCloseOutcome, ArcSummary, ArcsPort } from "@keywork/tui";
import type { SessionKey, WorkspaceMemory } from "./memory.ts";

export interface ArcServiceOptions {
  cwd: string;
  trusted: boolean;
  workspaceSlug?: string | undefined;
  memory: () => WorkspaceMemory | undefined;
  boundSessionCounts: () => Promise<ReadonlyMap<string, number>>;
  now?: () => Date;
}

export interface ArcService {
  readonly port: ArcsPort;
  readonly bindings: ArcBindings;
  registry(): ArcRegistry | undefined;
  attached(store: SessionStore): void;
  released(sessionId: string): void;
  recordBinding(sessionId: string, arc: string | undefined): void;
  layerStoreFor(sessionId: string): MemoryStore | undefined;
  searcher(
    workspace: MemorySearch,
    session: SessionKey,
    embeddings?: EmbeddingsPort,
  ): MemorySearcher;
}

export const arcsUnavailable =
  "arcs need a trusted workspace with memory · send a prompt or run keywork init first";

export function arcService(options: ArcServiceOptions): ArcService {
  const bindings = new ArcBindings();
  const listeners = new Set<() => void>();
  const registries = new Map<string, ArcRegistry>();
  const recalls = new WeakMap<ArcRegistry, ArcRecall>();
  const changed = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const registry = (): ArcRegistry | undefined => {
    if (!options.trusted) return undefined;
    const vaultRoot = resolveVaultPath(options.cwd, options.workspaceSlug);
    if (vaultRoot === undefined) return undefined;
    const existing = registries.get(vaultRoot);
    if (existing !== undefined) return existing;
    const created = new ArcRegistry({
      vaultRoot,
      trusted: true,
      ...(options.now !== undefined && { now: options.now }),
    });
    registries.set(vaultRoot, created);
    return created;
  };
  const requireRegistry = (): ArcRegistry => {
    const found = registry();
    if (found === undefined) throw new Error(arcsUnavailable);
    return found;
  };
  const airlock = (): ArcAirlock => {
    const memory = options.memory();
    if (memory === undefined) throw new Error(arcsUnavailable);
    return new ArcAirlock({
      registry: requireRegistry(),
      bindings,
      workspace: memory.store,
      inbox: memory.inbox,
      ...(options.now !== undefined && { now: options.now }),
    });
  };
  const port: ArcsPort = {
    list: async () => {
      const found = registry();
      if (found === undefined) return [];
      const counts = await options.boundSessionCounts();
      return (await found.listArcs()).map((record) => ({
        slug: record.slug,
        status: record.status,
        created: record.created,
        sessions: counts.get(record.slug) ?? 0,
      }));
    },
    create: async (slug) => {
      const record = await requireRegistry().createArc(slug);
      changed();
      return { slug: record.slug, status: record.status, created: record.created, sessions: 0 };
    },
    close: async (slug) => {
      const outcome = await closeThroughAirlock(airlock(), slug);
      changed();
      return outcome;
    },
    abandon: async (slug) => {
      await airlock().abandon(slug);
      changed();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    port,
    bindings,
    registry,
    attached: (store) => {
      const arc = store.arcBinding();
      if (arc === undefined) bindings.unbind(store.header.id);
      else bindings.bind(store.header.id, arc);
    },
    released: (sessionId) => {
      bindings.unbind(sessionId);
    },
    recordBinding: (sessionId, arc) => {
      if (arc === undefined) bindings.unbind(sessionId);
      else bindings.bind(sessionId, arc);
      changed();
    },
    layerStoreFor: (sessionId) => {
      const arc = bindings.bindingOf(sessionId);
      if (arc === undefined) return undefined;
      return registry()?.arcStore(arc);
    },
    searcher: (workspace, session, embeddings) => ({
      search: async (query, searchOptions) => {
        const found = registry();
        const activeArc = bindings.bindingOf(resolveSession(session) ?? "");
        if (found === undefined || activeArc === undefined) {
          return workspace.search(query, searchOptions);
        }
        const recall = recalls.get(found) ?? recallOver(found, workspace, embeddings);
        recalls.set(found, recall);
        const outcome = await recall.searchAmbient(query, activeArc, searchOptions);
        return { hits: outcome.hits, source: outcome.workspaceSource };
      },
    }),
  };
}

async function closeThroughAirlock(airlock: ArcAirlock, slug: string): Promise<ArcCloseOutcome> {
  const digest = await airlock.prepareClose(slug, { force: true });
  if (digest.candidates.length > 0 || digest.questions.length > 0) {
    return {
      kind: "pending",
      candidates: digest.candidates.length,
      questions: digest.questions.length,
      wedged: digest.sweep.wedged.length,
    };
  }
  const delivery = await airlock.completeClose(slug, { candidates: {}, questions: {} });
  return {
    kind: "closed",
    delivered: delivery.delivered.length,
    released: delivery.releasedSessions.length,
  };
}

function recallOver(
  registry: ArcRegistry,
  workspace: MemorySearch,
  embeddings: EmbeddingsPort | undefined,
): ArcRecall {
  return new ArcRecall({
    workspace,
    registry,
    ...(embeddings !== undefined && { embeddings }),
  });
}

function resolveSession(session: SessionKey): string | undefined {
  return typeof session === "function" ? session() : session;
}

export type { ArcSummary };
