import { type SessionStore, SessionTrash } from "@keywork/engine";
import type { Refusal, SessionLifecyclePort, SessionSummary } from "@keywork/server";
import type { ServedSession } from "./serve-surfaces.ts";
import { discardTrashed, restoreSession, trashStore } from "./sessions/lifecycle.ts";
import { type SessionSummary as StoredSummary, scanSessions, summarize } from "./sessions/store.ts";

export interface LifecycleSessions {
  sessionDir: string;
  bound(id: string): Promise<ServedSession | undefined>;
  release(id: string): Promise<void>;
  summaryOf(stored: StoredSummary, store: SessionStore): SessionSummary;
  keeps?: ((id: string, store: SessionStore) => Promise<string | undefined>) | undefined;
}

export function servedLifecycle(sessions: LifecycleSessions): SessionLifecyclePort {
  const { sessionDir } = sessions;
  const wireSummary = async (store: SessionStore): Promise<SessionSummary> =>
    sessions.summaryOf(await summarize(store), store);
  return {
    remove: (id) =>
      trashSession(sessions, id, async (session) => {
        const kept = await sessions.keeps?.(id, session.store);
        if (kept !== undefined) throw new Error(kept);
      }),
    trash: async () => {
      const { stores } = await scanSessions(new SessionTrash(sessionDir).dir);
      const summaries = await Promise.all(stores.map(wireSummary));
      return summaries.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    },
    restore: async (id) => {
      const restored = await restoreSession(sessionDir, id);
      return restored === undefined ? undefined : wireSummary(restored);
    },
    discard: async (id) => {
      const discarded = await discardTrashed(sessionDir, id);
      return discarded === undefined
        ? undefined
        : { id: discarded.id, ...summaryFields(discarded) };
    },
    purge: () => new SessionTrash(sessionDir).purge(),
  };
}

export async function trashSession(
  sessions: LifecycleSessions,
  id: string,
  admit: (session: ServedSession) => Promise<void> = async () => {},
): Promise<SessionSummary | Refusal> {
  const session = await sessions.bound(id);
  if (session === undefined) return "missing";
  if (session.busy()) return "busy";
  await admit(session);
  await sessions.release(id);
  return sessions.summaryOf(await trashStore(sessions.sessionDir, session.store), session.store);
}

function summaryFields(stored: StoredSummary): Omit<SessionSummary, "id"> {
  return {
    title: stored.title,
    createdAt: stored.createdAt,
    lastActivityAt: stored.lastActivityAt,
    messageCount: stored.messageCount,
    ...(stored.costNanos !== undefined && { costNanos: stored.costNanos }),
    ...(stored.arc !== undefined && { arc: stored.arc }),
    ...(stored.bot !== undefined && { bot: stored.bot }),
  };
}
