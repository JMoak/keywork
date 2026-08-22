import { join } from "node:path";
import { parseReference, replaySession, SessionStore, type Usage } from "@keywork/engine";
import type {
  SessionAttachment,
  SessionOverviewItem,
  SessionPort,
  SessionTreePort,
  SessionTreeView,
} from "@keywork/tui";
import {
  findSession,
  newSessionFileName,
  type SessionSummary,
  scanSessions,
  summarize,
} from "./store.ts";

export interface SessionPortSeams {
  checkpointTag?(): string | undefined;
  onAttach?(store: SessionStore): void;
  onRelease?(sessionId: string): void;
  onChange?(sessionId: string): void;
  onListen?(sessionId: string, stop: () => void): void;
  onArcBound?(sessionId: string, arc: string | undefined): void;
}

export interface SessionChangeFeed {
  emit(sessionId: string): void;
  subscribe(listener: (sessionId: string) => void): () => void;
}

export function sessionPort(dir: string, cwd: string, seams: SessionPortSeams = {}): SessionPort {
  const listeners = new Map<string, Set<() => void>>();
  const attach = (store: SessionStore): SessionAttachment => {
    seams.onAttach?.(store);
    return attachmentOf(store, {
      ...seams,
      onListen: (sessionId, stop) => {
        const stops = listeners.get(sessionId) ?? new Set();
        stops.add(stop);
        listeners.set(sessionId, stops);
        seams.onListen?.(sessionId, stop);
      },
    });
  };
  return {
    async open(id: string): Promise<SessionAttachment | undefined> {
      const store = await findSession(dir, id);
      return store === undefined ? undefined : attach(store);
    },
    async create(): Promise<SessionAttachment> {
      return attach(await SessionStore.create(join(dir, newSessionFileName()), cwd));
    },
    release(sessionId: string): void {
      for (const stop of listeners.get(sessionId) ?? []) stop();
      listeners.delete(sessionId);
      seams.onRelease?.(sessionId);
    },
  };
}

export function sessionTreePort(dir: string, changes?: SessionChangeFeed): SessionTreePort {
  const openOrFail = async (sessionId: string): Promise<SessionStore> => {
    const store = await findSession(dir, sessionId);
    if (store === undefined) throw new Error(`no session matches id ${sessionId}`);
    return store;
  };
  return {
    async overview(): Promise<SessionOverviewItem[]> {
      const { stores } = await scanSessions(dir);
      const used = stores.filter((store) => store.stats().entries > 0);
      const items = await Promise.all(
        used.map(async (store) => overviewItem(await summarize(store))),
      );
      return items.sort((a, b) => b.modifiedAt - a.modifiedAt);
    },
    async load(sessionId: string): Promise<SessionTreeView | undefined> {
      const store = await findSession(dir, sessionId);
      if (store === undefined) return undefined;
      const name = store.name();
      return {
        sessionId: store.header.id,
        roots: store.tree(),
        ...(name !== undefined && { name }),
      };
    },
    async setLabel(sessionId: string, entryId: string, label: string | undefined): Promise<void> {
      const store = await openOrFail(sessionId);
      await store.setLabel(entryId, label);
      changes?.emit(store.header.id);
    },
    async fork(sessionId: string, entryId: string): Promise<string | undefined> {
      const store = await findSession(dir, sessionId);
      if (store === undefined) return undefined;
      const clone = await store.clone(join(dir, newSessionFileName()), entryId);
      changes?.emit(store.header.id);
      return clone.header.id;
    },
    ...(changes !== undefined && {
      subscribe: (listener: (sessionId: string) => void) => changes.subscribe(listener),
    }),
  };
}

export function sessionChangeFeed(): SessionChangeFeed {
  const listeners = new Set<(sessionId: string) => void>();
  return {
    emit: (sessionId) => {
      for (const listener of [...listeners]) listener(sessionId);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function attachmentOf(
  store: SessionStore,
  seams: Pick<SessionPortSeams, "checkpointTag" | "onChange" | "onListen" | "onArcBound"> = {},
): SessionAttachment {
  const name = store.name();
  const selection = store.modelSelection();
  const arc = store.arcBinding();
  const finishedTurnUsage: Usage[] = [];
  return {
    id: store.header.id,
    ...(name !== undefined && { name }),
    ...(selection !== undefined && {
      modelReference: `${selection.provider}/${selection.modelId}`,
    }),
    ...(arc !== undefined && { arc }),
    history: store.messages(),
    replay: (bus) => {
      replaySession(store, bus);
      const stop = bus.on("turn.delta", ({ delta, replay }) => {
        if (replay !== true && delta.type === "done") finishedTurnUsage.push(delta.usage);
      });
      seams.onListen?.(store.header.id, stop);
    },
    append: async (message) => {
      const checkpoint = message.role === "user" ? seams.checkpointTag?.() : undefined;
      const usage = message.role === "assistant" ? finishedTurnUsage.shift() : undefined;
      const entry = await store.append(message, usage, checkpoint);
      seams.onChange?.(store.header.id);
      return { entryId: entry.id };
    },
    rename: async (title) => {
      await store.setName(title);
      seams.onChange?.(store.header.id);
    },
    recordModel: async (reference) => {
      const current = store.modelSelection();
      const parsed = parseReference(reference);
      if (parsed === undefined) return;
      if (current?.provider === parsed.provider && current.modelId === parsed.model) return;
      await store.appendModelChange(parsed.provider, parsed.model);
      seams.onChange?.(store.header.id);
    },
    bindArc: async (slug) => {
      if (store.arcBinding() === slug) return;
      await store.appendArcBinding(slug);
      seams.onArcBound?.(store.header.id, slug);
      seams.onChange?.(store.header.id);
    },
  };
}

export async function boundSessionCounts(dir: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const { stores } = await scanSessions(dir);
  for (const store of stores) {
    const arc = store.arcBinding();
    if (arc !== undefined) counts.set(arc, (counts.get(arc) ?? 0) + 1);
  }
  return counts;
}

function overviewItem(summary: SessionSummary): SessionOverviewItem {
  return {
    id: summary.id,
    title: summary.title,
    modifiedAt: Date.parse(summary.lastActivityAt),
    entryCount: summary.entryCount,
    branchCount: summary.branchCount,
    labelCount: summary.labelCount,
    ...(summary.costNanos !== undefined && { costNanos: summary.costNanos }),
    ...(summary.arc !== undefined && { arc: summary.arc }),
  };
}
