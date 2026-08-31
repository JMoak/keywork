import {
  ArcAirlock,
  ArcBindings,
  ArcCloseDraft,
  ArcRecall,
  ArcRegistry,
  type ArcReview,
  type EmbeddingsPort,
  IneligibleDeliveryError,
  isStagedWrite,
  type MemorySearch,
  type MemorySearcher,
  type MemoryStore,
  MissingSuccessorError,
  type SessionStore,
  type StagedItem,
  WedgedSessionsError,
} from "@keywork/engine";
import { resolveVaultPath } from "@keywork/shared";
import type {
  AirlockDigestView,
  AirlockFinishOutcome,
  ArcAirlockPort,
  ArcCloseOutcome,
  ArcsPort,
} from "@keywork/tui";
import type { SessionKey, WorkspaceMemory } from "./memory.ts";

export type SessionFlush = () => Promise<unknown>;

export interface ArcServiceOptions {
  cwd: string;
  trusted: boolean;
  workspaceSlug?: string | undefined;
  memory: () => WorkspaceMemory | undefined;
  boundSessionCounts: () => Promise<ReadonlyMap<string, number>>;
  flushFor?: ((sessionId: string) => SessionFlush | undefined) | undefined;
  onReleased?: ((sessionId: string) => void) | undefined;
  unavailable?: (() => string) | undefined;
  now?: () => Date;
}

export interface ArcService {
  readonly port: ArcsPort;
  readonly bindings: ArcBindings;
  registry(): ArcRegistry | undefined;
  attached(store: SessionStore): Promise<void>;
  released(sessionId: string): void;
  recordBinding(sessionId: string, arc: string | undefined): void;
  layerStoreFor(sessionId: string): MemoryStore | undefined;
  routeStragglers(slug: string): Promise<string[]>;
  searcher(
    workspace: MemorySearch,
    session: SessionKey,
    embeddings?: EmbeddingsPort,
  ): MemorySearcher;
}

export const arcsUnavailable = "arcs need a trusted workspace with memory · /init sets one up";

export function arcService(options: ArcServiceOptions): ArcService {
  const bindings = new ArcBindings();
  const attachedStores = new Map<string, SessionStore>();
  const listeners = new Set<() => void>();
  const registries = new Map<string, ArcRegistry>();
  const recalls = new WeakMap<ArcRegistry, ArcRecall>();
  const drafts = new Map<string, ArcCloseDraft>();
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
  const unavailable = (): Error => new Error(options.unavailable?.() ?? arcsUnavailable);
  const requireRegistry = (): ArcRegistry => {
    const found = registry();
    if (found === undefined) throw unavailable();
    return found;
  };
  const requireMemory = (): WorkspaceMemory => {
    const memory = options.memory();
    if (memory === undefined) throw unavailable();
    return memory;
  };
  const airlock = (): ArcAirlock => {
    const memory = requireMemory();
    const found = requireRegistry();
    return new ArcAirlock({
      registry: found,
      bindings,
      workspace: memory.store,
      citedNotes: (slug) => recalledArcNotes(memory, found, slug),
      ...(options.now !== undefined && { now: options.now }),
    });
  };
  const draftFor = (slug: string): ArcCloseDraft => {
    const existing = drafts.get(slug);
    if (existing !== undefined) return existing;
    const created = new ArcCloseDraft();
    drafts.set(slug, created);
    return created;
  };
  const flushesFor = (slug: string, alreadyAcked: readonly string[]): Map<string, SessionFlush> =>
    new Map(
      bindings.sessionsBoundTo(slug).flatMap((sessionId): [string, SessionFlush][] => {
        if (alreadyAcked.includes(sessionId)) return [[sessionId, async () => undefined]];
        const flush = options.flushFor?.(sessionId);
        return flush === undefined ? [] : [[sessionId, flush]];
      }),
    );
  const persistRelease = async (sessionIds: readonly string[]): Promise<void> => {
    for (const sessionId of sessionIds) {
      const store = attachedStores.get(sessionId);
      if (store?.arcBinding() === undefined) continue;
      await store.appendArcBinding(undefined);
      options.onReleased?.(sessionId);
    }
  };
  const routeStragglers = async (slug: string): Promise<string[]> => {
    if (options.memory() === undefined || registry() === undefined) return [];
    const routed = await airlock().routeStragglers(slug);
    if (routed.length > 0) changed();
    return routed;
  };
  const settleArchivedBinding = async (store: SessionStore, arc: string): Promise<void> => {
    const record = await registry()?.readArc(arc);
    if (record?.status !== "archived") return;
    bindings.unbind(store.header.id);
    await store.appendArcBinding(undefined);
    options.onReleased?.(store.header.id);
    await routeStragglers(arc);
    changed();
  };
  const reviewOf = (slug: string): Promise<ArcReview> => airlock().review(slug);
  const successorFor = async (slug: string): Promise<string> => {
    const drafted = draftFor(slug).successorArc();
    if (drafted !== undefined) return drafted;
    const others = (await requireRegistry().listArcs())
      .filter((arc) => arc.status === "active" && arc.slug !== slug)
      .sort((left, right) => right.created.localeCompare(left.created));
    const newest = others[0];
    if (newest === undefined) throw new MissingSuccessorError(slug);
    return newest.slug;
  };
  const finishClose = async (slug: string, force: boolean): Promise<AirlockFinishOutcome> => {
    const draft = draftFor(slug);
    const acked = draft.lastSweep()?.acked ?? [];
    const digest = await airlock().prepareClose(slug, { flushes: flushesFor(slug, acked), force });
    draft.recordSweep(digest.sweep);
    draft.leaveBelowBar(digest.candidates);
    const undecided = draft.undecided(digest);
    if (undecided.length > 0) {
      changed();
      return { kind: "undecided", items: undecided };
    }
    const delivery = await airlock().completeClose(slug, draft.decisions(digest));
    drafts.delete(slug);
    await persistRelease(delivery.releasedSessions);
    changed();
    return {
      kind: "closed",
      delivered: delivery.delivered.length,
      released: delivery.releasedSessions.length,
    };
  };
  const airlockPort: ArcAirlockPort = {
    digest: async (slug) => {
      const memory = options.memory();
      const found = registry();
      if (memory === undefined || found === undefined) return undefined;
      if ((await found.readArc(slug))?.status !== "active") return undefined;
      if (!(await memory.store.listStaged()).some((item) => isArcReviewFor(item, slug)))
        return undefined;
      return digestView(slug, await reviewOf(slug), draftFor(slug));
    },
    triageCandidate: async (slug, note, choice) => {
      const review = await reviewOf(slug);
      const candidate = review.candidates.find((found) => found.note.name === note);
      if (candidate === undefined) throw new Error(`arc ${slug} has no candidate named ${note}`);
      if (choice === "deliver" && !candidate.eligible)
        throw new IneligibleDeliveryError(slug, note, candidate.shortfalls);
      draftFor(slug).decideCandidate(note, choice);
      changed();
    },
    triageQuestion: async (slug, title, choice) => {
      const review = await reviewOf(slug);
      if (!review.questions.some((question) => question.title === title))
        throw new Error(`arc ${slug} has no open question titled ${title}`);
      const successor = choice === "carry" ? await successorFor(slug) : undefined;
      draftFor(slug).decideQuestion(title, choice, successor);
      changed();
    },
    deliverEligible: async (slug) => {
      const review = await reviewOf(slug);
      const delivered = draftFor(slug).deliverEligible(review.candidates);
      changed();
      return delivered;
    },
    finish: async (slug, finishOptions = {}) => {
      try {
        return await finishClose(slug, finishOptions.force === true);
      } catch (cause) {
        if (cause instanceof WedgedSessionsError)
          return { kind: "wedged", sessions: cause.sessions };
        throw cause;
      }
    },
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
      const draft = draftFor(slug);
      const digest = await airlock().prepareClose(slug, {
        flushes: flushesFor(slug, draft.lastSweep()?.acked ?? []),
        force: true,
      });
      draft.recordSweep(digest.sweep);
      if (digest.candidates.length > 0 || digest.questions.length > 0) {
        changed();
        return pendingOutcome(digest.candidates.length, digest.questions.length, digest.sweep);
      }
      const delivery = await airlock().completeClose(slug, { candidates: {}, questions: {} });
      drafts.delete(slug);
      await persistRelease(delivery.releasedSessions);
      changed();
      return {
        kind: "closed",
        delivered: delivery.delivered.length,
        released: delivery.releasedSessions.length,
      };
    },
    abandon: async (slug) => {
      const boundSessions = bindings.sessionsBoundTo(slug);
      await airlock().abandon(slug);
      drafts.delete(slug);
      await persistRelease(boundSessions);
      changed();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    airlock: airlockPort,
  };
  return {
    port,
    bindings,
    registry,
    attached: (store) => {
      attachedStores.set(store.header.id, store);
      const arc = store.arcBinding();
      if (arc === undefined) {
        bindings.unbind(store.header.id);
        return Promise.resolve();
      }
      bindings.bind(store.header.id, arc);
      return settleArchivedBinding(store, arc);
    },
    released: (sessionId) => {
      attachedStores.delete(sessionId);
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
    routeStragglers,
    searcher: (workspace, session, embeddings) => ({
      search: async (query, searchOptions) => {
        const found = registry();
        const sessionId = resolveSession(session);
        const activeArc = sessionId === undefined ? undefined : bindings.bindingOf(sessionId);
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

function pendingOutcome(
  candidates: number,
  questions: number,
  sweep: { wedged: string[] },
): ArcCloseOutcome {
  return { kind: "pending", candidates, questions, wedged: sweep.wedged.length };
}

function digestView(slug: string, review: ArcReview, draft: ArcCloseDraft): AirlockDigestView {
  const sweep = draft.lastSweep();
  const successor = draft.successorArc();
  return {
    arc: slug,
    candidates: review.candidates.map((candidate) => {
      const choice = draft.candidateDecision(candidate.note.name);
      return {
        note: candidate.note.name,
        title: candidate.note.title,
        provenance: candidate.note.provenance,
        eligible: candidate.eligible,
        shortfalls: [...candidate.shortfalls],
        ...(candidate.note.created !== undefined && { created: candidate.note.created }),
        ...(choice !== undefined && { choice }),
      };
    }),
    questions: review.questions.map((question) => {
      const choice = draft.questionDecision(question.title);
      return {
        title: question.title,
        provenance: question.provenance,
        created: question.created,
        ...(choice !== undefined && { choice }),
      };
    }),
    ...(successor !== undefined && { successor }),
    ...(sweep !== undefined && {
      sweep: { acked: sweep.acked.length, wedged: sweep.wedged.length },
    }),
  };
}

function isArcReviewFor(item: StagedItem, slug: string): boolean {
  if (isStagedWrite(item)) return false;
  return (item.kind === "arc-distillation" || item.kind === "arc-question") && item.arc === slug;
}

async function recalledArcNotes(
  memory: WorkspaceMemory,
  registry: ArcRegistry,
  slug: string,
): Promise<string[]> {
  const recalled = [...memory.gardener.recallsSinceSweep().keys()];
  const useful = (await registry.arcStore(slug).listNotes())
    .filter((note) => (note.usefulness ?? 0) > 0)
    .map((note) => note.name);
  return [...recalled, ...useful];
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
